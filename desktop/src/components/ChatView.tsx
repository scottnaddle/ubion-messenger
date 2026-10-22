import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, media, type ChatMessage, type Presence, type Room, type SessionUser } from "../api";
import { dedupeByMessageId, upsertMessage } from "../../electron/core/messages";
import { isSendEnter } from "../lib/composer";
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
      } else if (type === "confirm" && (!payload.roomKey || payload.roomKey === room.key)) {
        // read receipts changed: refresh counts of the latest page quietly
        api().call<ChatMessage[]>("msg:history", room.key).then((list) => {
          setMsgs((l) => {
            const byId = new Map(list.map((m) => [m.messageId, m]));
            return l.map((m) => (m.messageId != null && byId.has(m.messageId) ? { ...m, needConfirmCount: byId.get(m.messageId)!.needConfirmCount } : m));
          });
        }).catch(() => undefined);
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
      createdAt: new Date().toISOString(), pending: true,
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
                    m={m} mine={mine} grouped={!!grouped} showTime={showTime} isGroup={room.kind !== "buddy"}
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
      {viewer?.attach && <ImageViewer m={viewer} onClose={() => setViewer(null)} toast={toast} />}
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
  m, mine, grouped, showTime, isGroup, onImage, onRetry, toast,
}: {
  m: ChatMessage; mine: boolean; grouped: boolean; showTime: boolean; isGroup: boolean;
  onImage: () => void; onRetry: () => void; toast: (t: string) => void;
}) {
  const deleted = m.messageType === "DELETEDMESSAGE";
  const a = m.attach;
  const isImage = !!a && (a.imageFile || /^(png|jpe?g|gif|webp|bmp|heic)$/i.test(a.extention || ""));
  const download = async (open: boolean) => {
    if (!a || m.messageId == null) return;
    try {
      await api().call("files:download", a.cryptId, m.messageId, a.name, open);
    } catch (e) {
      toast(`다운로드 실패: ${(e as Error).message}`);
    }
  };
  return (
    <div className={`msg ${mine ? "mine" : ""} ${grouped ? "grouped" : ""}`}>
      {!mine && <div className="msg-av">{!grouped && <Avatar name={m.sendUserName} src={m.userImage} size={34} />}</div>}
      <div className="msg-main">
        {!mine && !grouped && <div className="msg-name">{m.sendUserName}</div>}
        <div className="msg-line">
          {deleted ? (
            <div className="bubble deleted">삭제된 메시지입니다</div>
          ) : a && isImage ? (
            <button className="img-bubble" onClick={onImage} title={a.name}>
              <img src={media(a.thumbMid || a.thumbLarge || a.thumbSmall)} alt={a.name} loading="lazy" />
            </button>
          ) : a ? (
            <div className="bubble file">
              <span className="file-ic"><Icon name="file" size={26} /></span>
              <div className="file-info">
                <div className="file-name">{a.name}</div>
                <div className="muted tiny">{fileSize(a.size)}</div>
              </div>
              <button className="icon-btn" title="열기" onClick={() => download(true)}><Icon name="image" size={18} /></button>
              <button className="icon-btn" title="다른 이름으로 저장" onClick={() => download(false)}><Icon name="download" size={18} /></button>
            </div>
          ) : (
            <div className="bubble"><Linkified text={m.message} /></div>
          )}
          <div className="msg-meta">
            {m.failed ? (
              <button className="link danger tiny" onClick={onRetry}>전송 실패 · 재시도</button>
            ) : m.pending ? (
              <span className="tiny muted">전송 중…</span>
            ) : (
              <>
                {!!m.needConfirmCount && <span className="unread-n">{isGroup || mine ? m.needConfirmCount : ""}</span>}
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

function ImageViewer({ m, onClose, toast }: { m: ChatMessage; onClose: () => void; toast: (t: string) => void }) {
  const a = m.attach!;
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  const src = m.messageId != null ? media(`/api/chat/files/${encodeURIComponent(a.cryptId)}?messageId=${m.messageId}`) : "";
  return (
    <div className="viewer" onClick={onClose}>
      <div className="viewer-bar" onClick={(e) => e.stopPropagation()}>
        <span className="file-name">{a.name}</span>
        <span className="muted tiny">{fileSize(a.size)}</span>
        <div className="grow" />
        <button className="icon-btn" title="저장" onClick={() => api().call("files:download", a.cryptId, m.messageId, a.name, false).catch((e) => toast(e.message))}>
          <Icon name="download" />
        </button>
        <button className="icon-btn" title="닫기 (Esc)" onClick={onClose}><Icon name="close" /></button>
      </div>
      <img
        className="viewer-img"
        src={media(a.thumbOriginal || a.thumbLarge) || src}
        onError={(e) => { if (src && (e.target as HTMLImageElement).src !== src) (e.target as HTMLImageElement).src = src; }}
        onClick={(e) => e.stopPropagation()}
        alt={a.name}
      />
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
