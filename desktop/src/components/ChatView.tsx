import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, media, type ChatMessage, type Presence, type Room, type SessionUser } from "../api";
import { applyReadReceipt, dedupeByMessageId, mergeReceipts, upsertMessage } from "../../electron/core/messages";
import { isSendEnter } from "../lib/composer";
import { FileCard, MediaViewer } from "./FileCard";
import { LinkPreview } from "./LinkPreview";
import { dayLabel, fileSize, parseTime, sameDay, timeLabel, URL_RE } from "../lib/format";
import { Avatar, Icon } from "./ui";
import type { Toast } from "../App";

const PRES_LABEL: Record<Presence, string> = { online: "온라인", away: "자리 비움", busy: "다른 용무 중", offline: "오프라인" };

export function ChatView({
  room, me, focused, presence, toast,
}: { room: Room; me: SessionUser; focused: boolean; presence?: Presence; toast: (t: string, k?: Toast["kind"]) => void }) {
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [viewer, setViewer] = useState<ChatMessage | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [uploading, setUploading] = useState(0);
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

  // realtime
  useEffect(() => {
    const h = (ev: Event) => {
      const { type, payload } = (ev as CustomEvent).detail;
      if (type === "message" && payload.roomKey === room.key) {
        const el = listRef.current;
        stickBottom.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120 || payload.isMine;
        setMsgs((l) => upsertMessage(l, payload));
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
                    isLastMine={m === lastMine}
                    onImage={() => setViewer(m)} onRetry={() => retry(m)} toast={toast}
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
          roomKey={room.key}
          onSend={sendText}
          onPick={async () => uploadPaths(await api().call<string[]>("files:pick"))}
          onPasteFile={uploadBlob}
        />
      ) : (
        <div className="composer readonly muted">이 채널은 읽기 전용입니다</div>
      )}
      {dragOver && <div className="drop-hint">여기에 놓아 파일 보내기</div>}
      {viewer?.attach && <MediaViewer m={viewer} onClose={() => setViewer(null)} toast={toast} />}
    </section>
  );
}

function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <a key={i} href={p} onClick={(e) => { e.preventDefault(); api().call("app:openExternal", p); }}>{p}</a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        )
      )}
    </>
  );
}

function MessageRow({
  m, mine, grouped, showTime, room, meId, isLastMine, onImage, onRetry, toast,
}: {
  m: ChatMessage; mine: boolean; grouped: boolean; showTime: boolean; room: Room; meId: number; isLastMine: boolean;
  onImage: () => void; onRetry: () => void; toast: (t: string) => void;
}) {
  const deleted = m.messageType === "DELETEDMESSAGE";
  // SENDFILE without an attach model (seen as "filename only" text): still render a (disabled) file card.
  const a = m.attach ?? (m.messageType === "SENDFILE" && m.message ? { cryptId: "", name: m.message } : undefined);
  return (
    <div className={`msg ${mine ? "mine" : ""} ${grouped ? "grouped" : ""}`}>
      {!mine && <div className="msg-av">{!grouped && <Avatar name={m.sendUserName} src={m.userImage} size={34} />}</div>}
      <div className="msg-main">
        {!mine && !grouped && <div className="msg-name">{m.sendUserName}</div>}
        <div className="msg-line">
          {deleted ? (
            <div className="bubble deleted">삭제된 메시지입니다</div>
          ) : a ? (
            <FileCard m={a === m.attach ? m : { ...m, attach: a }} mine={mine} onOpenMedia={onImage} toast={toast} />
          ) : (
            <div className="bubble-col">
              <div className="bubble"><Linkified text={m.message} /></div>
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
  roomKey, onSend, onPick, onPasteFile,
}: { roomKey: string; onSend: (t: string) => void; onPick: () => void; onPasteFile: (f: File) => void }) {
  const [text, setText] = useState("");
  const composing = useRef(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const drafts = useRef<Record<string, string>>({});

  useEffect(() => {
    setText(drafts.current[roomKey] || "");
    ta.current?.focus();
  }, [roomKey]);
  useEffect(() => {
    drafts.current[roomKey] = text;
    const el = ta.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  }, [text, roomKey]);

  const submit = () => {
    const t = text.replace(/\s+$/, "");
    if (!t.trim()) return;
    setText("");
    onSend(t);
  };

  return (
    <div className="composer">
      <button className="icon-btn" title="파일 첨부" onClick={onPick}><Icon name="clip" /></button>
      <textarea
        ref={ta}
        rows={1}
        value={text}
        placeholder="메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)"
        onChange={(e) => setText(e.target.value)}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => (composing.current = false)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          const native = e.nativeEvent as KeyboardEvent;
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
            <div className="small hit-text">{m.message}</div>
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
