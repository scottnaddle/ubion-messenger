import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, media, type ChatMessage, type Presence, type Room, type SessionUser } from "../api";
import {
  filterMembers, findMentionTrigger, insertMention, parseMentionTokens,
  type MentionMember, type MentionTrigger,
} from "../lib/mention";
import { applyReadReceipt, dedupeByMessageId, mergeReceipts, upsertMessage } from "../../electron/core/messages";
import {
  applyChatDelete, canDeleteMessage, CHAT_DELETE_CONFIRM, CHAT_DELETED_PLACEHOLDER, isDeletedMessage,
} from "../../electron/core/chat-delete";
import { isSendEnter } from "../lib/composer";
import { FileCard, MediaViewer } from "./FileCard";
import { LinkPreview } from "./LinkPreview";
import { dayLabel, fileSize, parseTime, sameDay, timeLabel, URL_RE } from "../lib/format";
import { Avatar, Icon } from "./ui";
import type { Toast, ToastFn } from "../App";

const PRES_LABEL: Record<Presence, string> = { online: "온라인", away: "자리 비움", busy: "다른 용무 중", offline: "오프라인" };

type MentionCandidate = MentionMember & { image?: string };

const memberCache = new Map<string, MentionCandidate[]>();
const memberPending = new Map<string, Promise<MentionCandidate[]>>();

/** Fetch room members once per room; both the composer and message rendering share this cache. */
function loadRoomMembers(roomKey: string): Promise<MentionCandidate[]> {
  const cached = memberCache.get(roomKey);
  if (cached) return Promise.resolve(cached);
  const pending = memberPending.get(roomKey);
  if (pending) return pending;
  const req = api()
    .call<MentionCandidate[]>("rooms:members", roomKey)
    .then((list) => {
      const members = (Array.isArray(list) ? list : [])
        .filter((m) => m && typeof m.name === "string" && m.name)
        .map((m) => ({
          userId: Number(m.userId), name: m.name,
          position: m.position || "", department: m.department || "", image: m.image || "",
        }));
      memberCache.set(roomKey, members);
      return members;
    })
    // don't cache failures, so a transient error doesn't disable mentions for the room until restart
    .catch(() => [] as MentionCandidate[])
    .finally(() => { memberPending.delete(roomKey); });
  memberPending.set(roomKey, req);
  return req;
}

export function ChatView({
  room, me, focused, presence, toast,
}: { room: Room; me: SessionUser; focused: boolean; presence?: Presence; toast: ToastFn }) {
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [viewer, setViewer] = useState<ChatMessage | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<ChatMessage | null>(null);
  const [roomMenu, setRoomMenu] = useState<{ x: number; y: number } | null>(null);
  const [roomMembers, setRoomMembers] = useState<MentionCandidate[]>([]);
  const isGroupRoom = room.kind === "room" && !room.isSelf;
  const memberNames = useMemo(() => roomMembers.map((m) => m.name), [roomMembers]);
  const listRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const prevHeight = useRef<number | null>(null);
  const lastReadSent = useRef<number>(0);

  // initial history
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api()
      .call<ChatMessage[]>("msg:history", room.key)
      .then((list) => {
        if (!alive) return;
        setMsgs(dedupeByMessageId(list));
        setHasMore(list.length >= 40);
        stickBottom.current = true;
      })
      .catch((e) => toast(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [room.key, toast]);

  // group room members (mentions + popup), cached per room
  useEffect(() => {
    let alive = true;
    setRoomMembers([]);
    if (!isGroupRoom) return () => { alive = false; };
    loadRoomMembers(room.key).then((list) => { if (alive) setRoomMembers(list); });
    return () => { alive = false; };
  }, [room.key, isGroupRoom]);

  // realtime
  useEffect(() => {
    const h = (ev: Event) => {
      const { type, payload } = (ev as CustomEvent).detail;
      if (type === "message" && payload.roomKey === room.key) {
        if (payload.attachUpdate) {
          // attach fill-in: replace the existing card only (never append), keep scroll position
          const { attachUpdate: _u, ...upd } = payload;
          setMsgs((l) => (l.some((x) => x.messageId === upd.messageId) ? upsertMessage(l, upd) : l));
        } else {
          const el = listRef.current;
          stickBottom.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120 || payload.isMine;
          setMsgs((l) => upsertMessage(l, payload));
        }
      } else if (type === "confirm" && payload.roomKey === room.key) {
        setMsgs((l) => applyReadReceipt(l, payload));
      } else if (type === "receipts" && payload.roomKey === room.key) {
        setMsgs((l) => mergeReceipts(l, payload.updates));
      }
    };
    window.addEventListener("ubion:event", h);
    return () => window.removeEventListener("ubion:event", h);
  }, [room.key]);

  // mark read only while room is open AND window focused AND visible
  const lastId = [...msgs].reverse().find((m) => m.messageId != null)?.messageId;
  useEffect(() => {
    if (!focused || document.hidden || !lastId) return;
    if (lastReadSent.current >= lastId && !room.unread) return;
    lastReadSent.current = lastId;
    api().call("msg:markRead", room.key, lastId).catch(() => undefined);
  }, [focused, lastId, room.key, room.unread]);

  // scroll management
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (prevHeight.current != null) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
    } else if (stickBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [msgs]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore || loading) return;
    const first = msgs.find((m) => m.messageId != null)?.messageId;
    if (!first) return;
    setLoadingOlder(true);
    try {
      const older = await api().call<ChatMessage[]>("msg:history", room.key, first);
      if (older.length < 40) setHasMore(false);
      if (older.length) {
        prevHeight.current = listRef.current?.scrollHeight ?? null;
        setMsgs((l) => dedupeByMessageId([...older, ...l]));
      }
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, hasMore, loading, msgs, room.key, toast]);

  const onScroll = () => {
    const el = listRef.current!;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 150) void loadOlder();
  };

  const sendText = async (text: string) => {
    const clientId = `c${Date.now()}${Math.random()}`;
    const optimistic: ChatMessage = {
      clientId, message: text, sendUserSeq: me.id, sendUserName: me.name, userImage: me.thumbnail || "",
      createdAt: new Date().toISOString(), pending: true, confirmUsers: [],
      needConfirmCount: room.kind === "room" ? Math.max(0, (room.memberCount || 1) - 1) : room.kind === "buddy" && !room.isSelf ? 1 : 0,
    };
    stickBottom.current = true;
    setMsgs((l) => [...l, optimistic]);
    try {
      const r = await api().call<{ messageId?: number }>("msg:send", room.key, text);
      setMsgs((l) => upsertMessage(l, { ...optimistic, messageId: r.messageId, pending: false }));
    } catch (e) {
      setMsgs((l) => l.map((m) => (m.clientId === clientId ? { ...m, pending: false, failed: true } : m)));
      toast(`전송 실패: ${(e as Error).message}`);
    }
  };

  const retry = (m: ChatMessage) => {
    setMsgs((l) => l.filter((x) => x.clientId !== m.clientId));
    void sendText(m.message);
  };

  const deletable = me.isMessageDeletable !== false;
  const requestDelete = (m: ChatMessage) => {
    if (!deletable || !canDeleteMessage(m, me.id)) return;
    setConfirmDelete(m);
  };
  const doDelete = async () => {
    const target = confirmDelete;
    if (!target?.messageId) return;
    setConfirmDelete(null);
    const ids = [target.messageId];
    const snapshot = msgs.find((m) => m.messageId === target.messageId);
    setMsgs((l) => applyChatDelete(l, ids));
    try {
      await api().deleteChatMessages(ids);
      toast("메시지를 삭제했습니다", "info");
    } catch (e) {
      if (snapshot) setMsgs((l) => l.map((m) => (m.messageId === target.messageId ? snapshot : m)));
      toast(`삭제하지 못했습니다: ${(e as Error).message}`);
    }
  };

  const uploadPaths = async (paths: string[]) => {
    if (!paths.length) return;
    setUploading((n) => n + paths.length);
    try {
      await api().call("files:sendPaths", room.key, paths);
    } catch (e) {
      toast(`업로드 실패: ${(e as Error).message}`);
    } finally {
      setUploading((n) => Math.max(0, n - paths.length));
    }
  };

  const uploadBlob = async (f: File) => {
    setUploading((n) => n + 1);
    try {
      const name = f.name && f.name !== "image.png" ? f.name : `캡처_${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      await api().call("files:sendBuffer", room.key, name, await f.arrayBuffer(), f.type);
    } catch (e) {
      toast(`업로드 실패: ${(e as Error).message}`);
    } finally {
      setUploading((n) => Math.max(0, n - 1));
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = [...e.dataTransfer.files];
    const paths = files.map((f) => api().pathForFile(f)).filter(Boolean);
    if (paths.length) void uploadPaths(paths);
    else files.forEach((f) => void uploadBlob(f));
  };

  const canSend = room.kind !== "pubsub" && room.kind !== "unknown";
  const toggleRoomPush = async () => {
    const next = !room.usePush;
    setRoomMenu(null);
    try {
      await api().setRoomPush(room.key, next);
      toast(next ? "이 대화방의 알림을 켰습니다" : "이 대화방의 알림을 껐습니다", "info");
    } catch (e) {
      toast(`알림 설정을 변경하지 못했습니다: ${(e as Error).message}`);
    }
  };
  const lastMine = [...msgs].reverse().find((m) => m.sendUserSeq === me.id && !m.pending && !m.failed);
  const subtitle =
    room.kind === "buddy"
      ? [room.position, presence ? PRES_LABEL[presence] : PRES_LABEL.offline].filter(Boolean).join(" · ")
      : room.kind === "room"
      ? `그룹 대화${room.memberCount ? ` · ${room.memberCount}명` : ""}`
      : "알림 채널";

  return (
    <section
      className={`chat ${dragOver ? "drag" : ""}`}
      onDragOver={(e) => { if (canSend) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={canSend ? onDrop : undefined}
    >
      <header className="chat-head">
        <Avatar name={room.name} src={room.avatar} size={34} presence={room.peerUserId ? presence || "offline" : undefined} />
        <div className="chat-title">
          <div className="name">{room.name}</div>
          <div className="sub muted">{subtitle}</div>
        </div>
        <button className={`icon-btn ${searchOpen ? "on" : ""}`} title="대화 내용 검색" onClick={() => setSearchOpen((s) => !s)}>
          <Icon name="search" size={18} />
        </button>
        <button
          className={`icon-btn ${roomMenu ? "on" : ""}`}
          title="대화방 메뉴"
          onClick={(e) => {
            if (roomMenu) return setRoomMenu(null);
            const r = e.currentTarget.getBoundingClientRect();
            setRoomMenu({ x: Math.max(8, Math.min(r.right - 170, window.innerWidth - 178)), y: r.bottom + 4 });
          }}
        >
          <Icon name="more" size={18} />
        </button>
      </header>
      <div className="chat-body">
        <div className="msg-list" ref={listRef} onScroll={onScroll}>
          {loadingOlder && <div className="loader-line">이전 메시지 불러오는 중…</div>}
          {!hasMore && !loading && <div className="history-start muted">대화의 시작입니다</div>}
          {loading ? (
            <div className="skeletons">{Array.from({ length: 6 }, (_, i) => <div key={i} className={`sk ${i % 2 ? "r" : ""}`} />)}</div>
          ) : (
            msgs.map((m, i) => {
              const prev = msgs[i - 1];
              const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
              const mine = m.sendUserSeq === me.id;
              const grouped =
                !newDay && prev && prev.sendUserSeq === m.sendUserSeq &&
                Math.abs((parseTime(m.createdAt)?.getTime() || 0) - (parseTime(prev.createdAt)?.getTime() || 0)) < 5 * 60_000;
              const next = msgs[i + 1];
              const showTime = !next || next.sendUserSeq !== m.sendUserSeq || timeLabel(next.createdAt) !== timeLabel(m.createdAt);
              return (
                <Fragment key={m.messageId ?? m.clientId ?? i}>
                  {newDay && <div className="day-sep"><span>{dayLabel(m.createdAt)}</span></div>}
                  <MessageRow
                    m={m} mine={mine} grouped={!!grouped} showTime={showTime} room={room} meId={me.id}
                    isLastMine={m === lastMine} memberNames={memberNames} myName={me.name}
                    onImage={() => setViewer(m)} onRetry={() => retry(m)} toast={toast}
                    onDelete={deletable && canDeleteMessage(m, me.id) ? () => requestDelete(m) : undefined}
                  />
                </Fragment>
              );
            })
          )}
        </div>
        {searchOpen && <SearchPanel room={room} onClose={() => setSearchOpen(false)} />}
      </div>
      {uploading > 0 && <div className="upload-bar">파일 {uploading}개 업로드 중…</div>}
      {canSend ? (
        <Composer
          roomKey={room.key} meId={me.id} isGroup={isGroupRoom}
          onSend={sendText}
          onPick={async () => uploadPaths(await api().call<string[]>("files:pick"))}
          onPasteFile={uploadBlob}
        />
      ) : (
        <div className="composer readonly muted">이 채널은 읽기 전용입니다</div>
      )}
      {dragOver && <div className="drop-hint">여기에 놓아 파일 보내기</div>}
      {viewer?.attach && <MediaViewer m={viewer} onClose={() => setViewer(null)} toast={toast} />}
      {roomMenu && (
        <RoomMenu
          x={roomMenu.x} y={roomMenu.y} usePush={room.usePush}
          onToggle={() => void toggleRoomPush()} onClose={() => setRoomMenu(null)}
        />
      )}
      {confirmDelete && (
        <div className="modal-back" onClick={() => setConfirmDelete(null)}>
          <div className="modal compose-discard" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="modal-body">
              <p>{CHAT_DELETE_CONFIRM}</p>
              <div className="approval-modal-actions">
                <button className="link" onClick={() => setConfirmDelete(null)}>취소</button>
                <button className="danger-btn" autoFocus onClick={() => void doDelete()}>삭제</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Linkified({ text, memberNames = [], myName = "" }: { text: string; memberNames?: string[]; myName?: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <a key={i} href={p} onClick={(e) => { e.preventDefault(); api().call("app:openExternal", p); }}>{p}</a>
        ) : (
          <MentionedText key={i} text={p} memberNames={memberNames} myName={myName} />
        )
      )}
    </>
  );
}

function MentionedText({ text, memberNames, myName }: { text: string; memberNames: string[]; myName: string }) {
  if (!memberNames.length) return <>{text}</>;
  return (
    <>
      {parseMentionTokens(text, memberNames).map((seg, i) =>
        seg.type === "mention" ? (
          <span key={i} className={`mention${seg.name === myName ? " mention-me" : ""}`}>{seg.value}</span>
        ) : (
          <Fragment key={i}>{seg.value}</Fragment>
        )
      )}
    </>
  );
}

function RoomMenu({
  x, y, usePush, onToggle, onClose,
}: { x: number; y: number; usePush: boolean; onToggle: () => void; onClose: () => void }) {
  useEffect(() => {
    const h = (e: Event) => { if (e instanceof KeyboardEvent && e.key !== "Escape") return; onClose(); };
    window.addEventListener("mousedown", h); window.addEventListener("keydown", h); window.addEventListener("blur", h);
    return () => { window.removeEventListener("mousedown", h); window.removeEventListener("keydown", h); window.removeEventListener("blur", h); };
  }, [onClose]);
  return (
    <div className="ctx-menu" role="menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      <button role="menuitem" onClick={() => { onClose(); onToggle(); }}>
        <Icon name={usePush ? "bellOff" : "bell"} size={14} /> {usePush ? "알림 끄기" : "알림 켜기"}
      </button>
    </div>
  );
}

function DeleteMenu({ x, y, onDelete, onClose }: { x: number; y: number; onDelete: () => void; onClose: () => void }) {
  useEffect(() => {
    const h = (e: Event) => { if (e instanceof KeyboardEvent && e.key !== "Escape") return; onClose(); };
    window.addEventListener("mousedown", h); window.addEventListener("keydown", h); window.addEventListener("blur", h);
    return () => { window.removeEventListener("mousedown", h); window.removeEventListener("keydown", h); window.removeEventListener("blur", h); };
  }, [onClose]);
  return (
    <div className="ctx-menu" role="menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      <button role="menuitem" className="danger" onClick={() => { onClose(); onDelete(); }}><Icon name="trash" size={14} /> 삭제</button>
    </div>
  );
}

function MessageRow({
  m, mine, grouped, showTime, room, meId, isLastMine, memberNames, myName, onImage, onRetry, toast, onDelete,
}: {
  m: ChatMessage; mine: boolean; grouped: boolean; showTime: boolean; room: Room; meId: number; isLastMine: boolean;
  memberNames: string[]; myName: string;
  onImage: () => void; onRetry: () => void; toast: ToastFn; onDelete?: () => void;
}) {
  const deleted = isDeletedMessage(m);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const openMenu = (e: React.MouseEvent) => {
    if (!onDelete || deleted) return;
    e.preventDefault();
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 170), y: Math.min(e.clientY, window.innerHeight - 70) });
  };
  // SENDFILE without an attach model (seen as "filename only" text): still render a (disabled) file card.
  const a = m.attach ?? (m.messageType === "SENDFILE" && m.message ? { cryptId: "", name: m.message }
    : m.messageType === "DELETEDFILE" ? { cryptId: "", name: m.message || "삭제된 파일", expired: true } : undefined);
  return (
    <div className={`msg ${mine ? "mine" : ""} ${grouped ? "grouped" : ""}`}>
      {menu && onDelete && <DeleteMenu x={menu.x} y={menu.y} onDelete={onDelete} onClose={() => setMenu(null)} />}
      {!mine && <div className="msg-av">{!grouped && <Avatar name={m.sendUserName} src={m.userImage} size={34} />}</div>}
      <div className="msg-main">
        {!mine && !grouped && <div className="msg-name">{m.sendUserName}</div>}
        <div className="msg-line">
          {deleted ? (
            <div className="bubble deleted">{CHAT_DELETED_PLACEHOLDER}</div>
          ) : a ? (
            <FileCard m={a === m.attach ? m : { ...m, attach: a }} mine={mine} onOpenMedia={onImage} toast={toast}
              canDelete={!!onDelete} onDelete={onDelete} />
          ) : (
            <div className="bubble-col">
              <div className="bubble" onContextMenu={openMenu}>
                <Linkified text={m.message} memberNames={memberNames} myName={myName} />
              </div>
              {!m.pending && <LinkPreview text={m.message} />}
            </div>
          )}
          <div className="msg-meta">
            {m.failed ? (
              <button className="link danger tiny" onClick={onRetry}>전송 실패 · 재시도</button>
            ) : m.pending ? (
              <span className="tiny muted">전송 중…</span>
            ) : (
              <>
                <ReadMark m={m} room={room} meId={meId} mine={mine} isLastMine={isLastMine} />
                {showTime && <span className="tiny muted">{timeLabel(m.createdAt)}</span>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Composer({
  roomKey, meId, isGroup, onSend, onPick, onPasteFile,
}: {
  roomKey: string; meId: number; isGroup: boolean;
  onSend: (t: string) => void; onPick: () => void; onPasteFile: (f: File) => void;
}) {
  const [text, setText] = useState("");
  const [members, setMembers] = useState<MentionCandidate[]>([]);
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
  const [cursorEnd, setCursorEnd] = useState(0);
  const [active, setActive] = useState(0);
  const composing = useRef(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const drafts = useRef<Record<string, string>>({});

  useEffect(() => {
    setText(drafts.current[roomKey] || "");
    setTrigger(null);
    ta.current?.focus();
  }, [roomKey]);

  useEffect(() => {
    let alive = true;
    setMembers([]);
    setTrigger(null);
    if (!isGroup) return () => { alive = false; };
    loadRoomMembers(roomKey).then((list) => { if (alive) setMembers(list); });
    return () => { alive = false; };
  }, [roomKey, isGroup]);

  useEffect(() => {
    drafts.current[roomKey] = text;
    const el = ta.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  }, [text, roomKey]);

  const suggestions = trigger && isGroup ? filterMembers(members, trigger.query, meId) : [];
  const open = !!trigger && suggestions.length > 0;
  const safeActive = suggestions.length ? Math.min(active, suggestions.length - 1) : 0;

  const syncTrigger = (value: string, pos: number) => {
    if (!isGroup) {
      setTrigger(null);
      return;
    }
    setTrigger(findMentionTrigger(value, pos));
    setCursorEnd(pos);
    setActive(0);
  };

  const pick = (member: MentionCandidate) => {
    if (!trigger) return;
    const current = ta.current?.value ?? text;
    const next = insertMention(current, trigger, cursorEnd, member.name);
    setText(next.text);
    setTrigger(null);
    requestAnimationFrame(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const submit = () => {
    const t = text.replace(/\s+$/, "");
    if (!t.trim()) return;
    setText("");
    setTrigger(null);
    onSend(t);
  };

  return (
    <div className="composer">
      {open && (
        <div className="mention-pop" role="listbox" aria-label="멘션할 멤버">
          {suggestions.map((member, i) => (
            <button
              key={member.userId}
              type="button"
              role="option"
              aria-selected={i === safeActive}
              className={`mention-item${i === safeActive ? " on" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(ev) => { ev.preventDefault(); pick(member); }}
            >
              <Avatar name={member.name} src={member.image} size={28} />
              <span className="mention-name">{member.name}</span>
              {member.position && <span className="mention-pos muted">{member.position}</span>}
            </button>
          ))}
        </div>
      )}
      <button className="icon-btn" title="파일 첨부" onClick={onPick}><Icon name="clip" /></button>
      <textarea
        ref={ta}
        rows={1}
        value={text}
        placeholder="메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)"
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          syncTrigger(value, e.target.selectionStart ?? value.length);
        }}
        onSelect={(e) => {
          const el = e.currentTarget;
          syncTrigger(el.value, el.selectionStart ?? el.value.length);
        }}
        onBlur={() => setTrigger(null)}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => (composing.current = false)}
        onKeyDown={(e) => {
          const native = e.nativeEvent as KeyboardEvent;
          const ime = !!native.isComposing || native.keyCode === 229 || composing.current;
          if (!ime && open) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => (i + 1) % suggestions.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
              return;
            }
            if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
              e.preventDefault();
              pick(suggestions[safeActive]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setTrigger(null);
              return;
            }
          }
          if (e.key !== "Enter") return;
          if (isSendEnter({ key: e.key, shiftKey: e.shiftKey, isComposing: native.isComposing, keyCode: native.keyCode, composingRef: composing.current })) {
            e.preventDefault();
            submit();
          } else if (!e.shiftKey) {
            // Enter during IME composition: let the IME commit, never send
          }
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length) {
            e.preventDefault();
            files.forEach(onPasteFile);
          }
        }}
      />
      <button className="send-btn" disabled={!text.trim()} title="전송" onClick={submit}><Icon name="send" size={18} /></button>
    </div>
  );
}

function SearchPanel({ room, onClose }: { room: Room; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<ChatMessage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    try {
      setRes(await api().call("msg:search", room.key, q.trim()));
    } catch {
      setRes([]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="search-panel">
      <div className="side-head">
        <h3>대화 검색</h3>
        <button className="icon-btn" onClick={onClose}><Icon name="close" size={16} /></button>
      </div>
      <form className="search-box" onSubmit={run}>
        <Icon name="search" size={16} />
        <input autoFocus placeholder="검색어 입력 후 Enter" value={q} onChange={(e) => setQ(e.target.value)} />
      </form>
      <div className="search-results">
        {busy && <div className="muted small pad">검색 중…</div>}
        {res && !busy && !res.length && <div className="muted small pad">결과 없음</div>}
        {res?.map((m) => (
          <div key={m.messageId} className="search-hit">
            <div className="small"><b>{m.sendUserName}</b> <span className="muted tiny">{dayLabel(m.createdAt)} {timeLabel(m.createdAt)}</span></div>
            <div className="small hit-text">{isDeletedMessage(m) ? CHAT_DELETED_PLACEHOLDER : m.message}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}

/**
 * Read receipt label, official semantics: unread member count (needConfirmCount) next to every message
 * while > 0, nothing for notice channels. Extra: subtle "읽음" under my latest 1:1 message once read.
 * Click opens who-read popover (group: member list from /api/chat/members).
 */
function ReadMark({ m, room, meId, mine, isLastMine }: { m: ChatMessage; room: Room; meId: number; mine: boolean; isLastMine: boolean }) {
  const [open, setOpen] = useState(false);
  if (room.kind === "pubsub" || room.isSelf || m.messageId == null) return null;
  const n = m.needConfirmCount || 0;
  if (n <= 0) {
    return mine && isLastMine && room.kind === "buddy" ? <span className="read-done tiny">읽음</span> : null;
  }
  return (
    <span className="read-wrap">
      <button
        className="unread-n"
        title={room.kind === "buddy" ? "상대방이 아직 읽지 않았습니다" : `${n}명이 읽지 않았습니다`}
        onClick={(e) => { e.stopPropagation(); if (room.kind === "room") setOpen((o) => !o); }}
      >
        {n}
      </button>
      {open && <ReadersPopover m={m} room={room} meId={meId} onClose={() => setOpen(false)} />}
    </span>
  );
}

function ReadersPopover({ m, room, meId, onClose }: { m: ChatMessage; room: Room; meId: number; onClose: () => void }) {
  const [members, setMembers] = useState<{ userId: number; name: string; image: string }[] | null>(null);
  useEffect(() => {
    api().call("rooms:members", room.key).then(setMembers).catch(() => setMembers([]));
    const h = () => onClose();
    setTimeout(() => window.addEventListener("click", h), 0);
    return () => window.removeEventListener("click", h);
  }, [room.key, onClose]);
  const read = new Set(m.confirmUsers || []);
  const others = (members || []).filter((u) => u.userId !== m.sendUserSeq);
  const unreadList = others.filter((u) => !read.has(u.userId));
  const readList = others.filter((u) => read.has(u.userId));
  return (
    <div className="readers" onClick={(e) => e.stopPropagation()}>
      {!members ? (
        <div className="muted small">불러오는 중…</div>
      ) : (
        <>
          <div className="readers-h">안 읽음 {unreadList.length}</div>
          {unreadList.map((u) => <div key={u.userId} className="readers-row"><Avatar name={u.name} src={u.image} size={20} />{u.name}{u.userId === meId ? " (나)" : ""}</div>)}
          <div className="readers-h">읽음 {readList.length}</div>
          {readList.map((u) => <div key={u.userId} className="readers-row muted"><Avatar name={u.name} src={u.image} size={20} />{u.name}{u.userId === meId ? " (나)" : ""}</div>)}
        </>
      )}
    </div>
  );
}
