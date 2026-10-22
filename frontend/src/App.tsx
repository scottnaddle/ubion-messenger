import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { useEvents } from "./hooks/useEvents";
import { isSendEnter } from "./lib/composer";
import { dedupeByMessageId, mergeMessages, upsertMessage } from "./lib/messages";
import type { Me, Message, Person, Room } from "./types";

type Theme = "dark" | "light";

function fmtTime(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Avatar({ src, name }: { src?: string; name: string }) {
  const initial = (name || "?").trim().slice(0, 1);
  const url = src ? api.thumb(src) : "";
  return (
    <div className="avatar" title={name}>
      {url ? <img src={url} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} /> : null}
      <span>{initial}</span>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("theme") as Theme) || "dark");
  const [me, setMe] = useState<Me | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [searchPeople, setSearchPeople] = useState<Person[]>([]);
  const [draft, setDraft] = useState("");
  const [xmppOk, setXmppOk] = useState(false);
  const [notifOk, setNotifOk] = useState(Notification.permission === "granted");
  const listRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const composingRef = useRef(false);
  const pendingSendRef = useRef(false);
  const active = useMemo(() => rooms.find((r) => r.key === activeKey) || null, [rooms, activeKey]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const meRef = useRef(me);
  meRef.current = me;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  const refreshRooms = useCallback(async () => {
    setLoadingRooms(true);
    try {
      const r = await api.rooms();
      setRooms(r.rooms);
      setErr("");
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      setLoadingRooms(false);
    }
  }, []);

  const boot = useCallback(async () => {
    try {
      await api.login();
      const m = await api.me();
      setMe(m);
      setXmppOk(!!m.xmppConnected);
      await refreshRooms();
    } catch (e: any) {
      setErr(String(e.message || e));
      setLoadingRooms(false);
    }
  }, [refreshRooms]);

  useEffect(() => {
    boot();
  }, [boot]);

  const openRoom = useCallback(async (room: Room) => {
    setActiveKey(room.key);
    setLoadingMsgs(true);
    stickBottom.current = true;
    try {
      const r = await api.messages(room.kind, room.seq, 50);
      setMessages(dedupeByMessageId(r.messages.map((m) => ({ ...m }))));
      setRooms((prev) => prev.map((x) => (x.key === room.key ? { ...x, unread: 0 } : x)));
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      setLoadingMsgs(false);
    }
  }, []);

  useEffect(() => {
    if (!listRef.current || !stickBottom.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, activeKey]);

  const loadOlder = async () => {
    if (!active || !messages.length) return;
    const el = listRef.current;
    const prevH = el?.scrollHeight || 0;
    const before = messages[0]?.messageId;
    if (!before) return;
    stickBottom.current = false;
    try {
      const r = await api.messages(active.kind, active.seq, 40, before);
      if (!r.messages.length) return;
      setMessages((m) => mergeMessages(r.messages, m));
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevH;
      });
    } catch (e: any) {
      setErr(String(e.message || e));
    }
  };

  useEvents(
    useCallback(
      (evt) => {
        if (evt.type === "hello" || evt.type === "xmpp") {
          setXmppOk(!!(evt.payload?.xmpp || evt.payload?.state === "connected"));
        }
        if (evt.type === "message") {
          const p = evt.payload as Message & { roomKind: string; roomSeq: number; usePush?: boolean };
          const keyGuess = rooms.find(
            (r) => r.kind === p.roomKind && r.seq === p.roomSeq
          )?.key;
          setRooms((prev) => {
            const idx = prev.findIndex((r) => r.kind === p.roomKind && r.seq === p.roomSeq);
            if (idx < 0) {
              // refresh list asynchronously
              refreshRooms();
              return prev;
            }
            const copy = [...prev];
            const room = { ...copy[idx] };
            room.preview = p.message || room.preview;
            room.messageId = p.messageId || room.messageId;
            const cur = activeRef.current;
            if (!cur || cur.key !== room.key) room.unread = (room.unread || 0) + 1;
            copy.splice(idx, 1);
            copy.unshift(room);
            return copy;
          });
          const cur = activeRef.current;
          if (cur && keyGuess === cur.key) {
            const withTs = {
              ...p,
              createdAt: p.createdAt || new Date().toISOString(),
            };
            setMessages((m) => upsertMessage(m, withTs));
          }
          if (document.hidden && notifOk && p.usePush !== false && p.message) {
            try {
              const n = new Notification(p.sendUserName || "새 메시지", {
                body: p.message.slice(0, 120),
                tag: String(p.messageId || Date.now()),
              });
              n.onclick = () => {
                window.focus();
                const room = rooms.find((r) => r.kind === p.roomKind && r.seq === p.roomSeq);
                if (room) openRoom(room);
              };
            } catch {
              /* ignore */
            }
          }
        }
      },
      [active, notifOk, openRoom, refreshRooms, rooms]
    )
  );

  useEffect(() => {
    if (!q.trim()) {
      setSearchPeople([]);
      return;
    }
    const t = window.setTimeout(async () => {
      try {
        const r = await api.search(q.trim());
        setSearchPeople(r.people);
      } catch {
        /* ignore */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const filteredRooms = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rooms;
    return rooms.filter((r) => r.name.toLowerCase().includes(s) || r.preview.toLowerCase().includes(s));
  }, [rooms, q]);

  const onSendFrom = async (textIn?: string) => {
    if (composingRef.current && textIn == null) return;
    const text = (textIn ?? draft).trim();
    if (!active || !text) return;
    if (!active.isSelf) {
      const ok = window.confirm(
        "이 방은 자기(메모) 대화가 아닙니다. 실제로 전송할까요?\n(테스트 중에는 취소하는 것을 권장합니다.)"
      );
      if (!ok) return;
    }
    setDraft("");
    const clientId = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const temp: Message = {
      clientId,
      message: text,
      sendUserName: me?.name || "나",
      sendUserSeq: me?.id,
      createdAt: new Date().toISOString(),
      userImage: me?.thumbnail || "",
      pending: true,
    };
    setMessages((m) => upsertMessage(m, temp));
    stickBottom.current = true;
    try {
      const r = await api.send(active.kind, active.seq, text, !active.isSelf);
      setMessages((m) =>
        upsertMessage(m, {
          ...temp,
          pending: false,
          messageId: r.messageId,
          clientId,
        })
      );
      setRooms((prev) => {
        const copy = [...prev];
        const i = copy.findIndex((x) => x.key === active.key);
        if (i >= 0) {
          const room = { ...copy[i], preview: text, messageId: r.messageId };
          copy.splice(i, 1);
          copy.unshift(room);
        }
        return copy;
      });
    } catch (e: any) {
      setMessages((m) =>
        m.map((x) => (x.clientId === clientId ? { ...x, pending: false, failed: true } : x))
      );
      setErr(String(e.message || e));
    }
  };

  const onSend = () => onSendFrom();

  const enableNotif = async () => {
    const p = await Notification.requestPermission();
    setNotifOk(p === "granted");
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="side-head">
          <div className="brand">
            <span className="logo">D</span>
            <div>
              <strong>Daou</strong>
              <div className="sub">
                {me ? me.name : "연결 중…"}
                <span className={`dot ${xmppOk ? "on" : "off"}`} title={xmppOk ? "XMPP 연결됨" : "XMPP 끊김"} />
              </div>
            </div>
          </div>
          <div className="tools">
            <button className="icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="테마">
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <button className="icon-btn" onClick={refreshRooms} title="새로고침">
              ↻
            </button>
          </div>
        </header>
        <div className="search">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="대화·사람 검색"
            spellCheck={false}
          />
        </div>
        {searchPeople.length > 0 && (
          <div className="people">
            <div className="section-label">사람들</div>
            {searchPeople.slice(0, 8).map((p) => (
              <button
                key={p.userId}
                className="room-row"
                onClick={() => {
                  const existing = rooms.find((r) => r.kind === "buddy" && r.seq === p.userId);
                  if (existing) openRoom(existing);
                  else {
                    const fake: Room = {
                      key: `buddy:${p.userId}:${me?.id}`,
                      kind: "buddy",
                      seq: p.userId,
                      name: p.name,
                      preview: "",
                      unread: 0,
                      usePin: false,
                      usePush: true,
                      avatar: p.thumbnail,
                      isSelf: p.userId === me?.id,
                    };
                    setRooms((r) => [fake, ...r]);
                    openRoom(fake);
                  }
                  setQ("");
                }}
              >
                <Avatar src={p.thumbnail} name={p.name} />
                <div className="meta">
                  <div className="name">
                    {p.name}
                    <span className="pos">{p.position}</span>
                  </div>
                  <div className="preview">{p.status || p.email}</div>
                </div>
              </button>
            ))}
          </div>
        )}
        <div className="room-list">
          <div className="section-label">대화 {loadingRooms ? "…" : `(${filteredRooms.length})`}</div>
          {filteredRooms.map((r) => (
            <button
              key={r.key}
              className={`room-row ${activeKey === r.key ? "active" : ""}`}
              onClick={() => openRoom(r)}
            >
              <Avatar src={r.avatar} name={r.name} />
              <div className="meta">
                <div className="name">
                  {r.isSelf ? "📝 " : r.kind === "room" ? "# " : ""}
                  {r.name}
                  {r.usePin ? <span className="pin">📌</span> : null}
                </div>
                <div className="preview">{r.preview}</div>
              </div>
              <div className="trail">
                <span className="time">{fmtTime(r.createdAt)}</span>
                {r.unread > 0 ? <span className="badge">{r.unread > 99 ? "99+" : r.unread}</span> : null}
              </div>
            </button>
          ))}
        </div>
        <footer className="side-foot">
          {!notifOk ? (
            <button className="linkish" onClick={enableNotif}>
              알림 허용
            </button>
          ) : (
            <span className="muted">알림 ON</span>
          )}
          <span className="muted">localhost MVP</span>
        </footer>
      </aside>

      <main className="chat">
        {!active ? (
          <div className="empty">
            <h1>Daou Messenger</h1>
            <p>왼쪽에서 대화를 선택하세요. XMPP 실시간 · REST 이력.</p>
            {err ? <pre className="err">{err}</pre> : null}
          </div>
        ) : (
          <>
            <header className="chat-head">
              <Avatar src={active.avatar} name={active.name} />
              <div>
                <h2>
                  {active.isSelf ? "메모 (나)" : active.name}
                  {active.memberCount ? <span className="muted"> · {active.memberCount}명</span> : null}
                </h2>
                <div className="muted">
                  {active.kind}:{active.seq}
                  {active.isSelf ? " · 자기 대화 (전송 테스트 가능)" : " · 전송 시 확인 필요"}
                </div>
              </div>
            </header>
            <div
              className="messages"
              ref={listRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                if (el.scrollTop < 40) loadOlder();
              }}
            >
              {loadingMsgs ? <div className="muted pad">불러오는 중…</div> : null}
              {messages.map((m, i) => {
                const mine = m.sendUserSeq === me?.id;
                const ts = m.createdAt || new Date().toISOString();
                return (
                  <div key={m.clientId || (m.messageId != null ? `id-${m.messageId}` : `i-${i}`)} className={`msg ${mine ? "mine" : ""} ${m.failed ? "failed" : ""}`}>
                    {!mine ? <Avatar src={m.userImage} name={m.sendUserName} /> : <div className="avatar spacer" />}
                    <div className="bubble">
                      <div className="msg-meta">
                        <strong>{mine ? "나" : m.sendUserName}</strong>
                        <span>{fmtTime(ts)}</span>
                        {m.pending ? <span className="muted">보내는 중…</span> : null}
                        {m.failed ? <span className="err-inline">실패</span> : null}
                      </div>
                      <div className="msg-body">{m.message}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <footer className="composer">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={active.isSelf ? "메모 입력… Enter 전송" : "메시지 입력… Enter 전송 (Shift+Enter 줄바꿈)"}
                rows={2}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={(e) => {
                  composingRef.current = false;
                  // Commit final composed value into React state before optional send
                  const v = (e.target as HTMLTextAreaElement).value;
                  setDraft(v);
                  if (pendingSendRef.current) {
                    pendingSendRef.current = false;
                    // defer so draft state / DOM value includes the last syllable
                    queueMicrotask(() => onSendFrom(v));
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.shiftKey) return;
                  const ne = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
                  const composing =
                    !!ne.isComposing ||
                    !!e.nativeEvent.isComposing ||
                    composingRef.current ||
                    (ne.keyCode ?? (e as any).keyCode) === 229;
                  if (composing) {
                    // Let IME commit the syllable; send once on compositionend
                    pendingSendRef.current = true;
                    return;
                  }
                  e.preventDefault();
                  onSend();
                }}
              />
              <button className="send" disabled={!draft.trim()} onClick={onSend}>
                전송
              </button>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
