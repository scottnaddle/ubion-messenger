import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ConnState, type Presence, type Room, type SessionUser, type Settings } from "./api";
import { Login } from "./components/Login";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { People } from "./components/People";
import { SettingsModal } from "./components/SettingsModal";
import { drawBadge } from "./lib/badge";
import { Avatar, Icon } from "./components/ui";
import { UpdateBanner } from "./components/UpdateBanner";
import { Home } from "./components/Home";
import { Menu } from "./components/Menu";
import { Mail } from "./components/Mail";
import { Approval } from "./components/Approval";
import { Todos } from "./components/Todos";

export type Toast = { id: number; text: string; kind?: "error" | "info"; action?: { label: string; onClick: () => void } };

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [booting, setBooting] = useState(true);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnState>("offline");
  const [netOnline, setNetOnline] = useState(navigator.onLine);
  const [presence, setPresence] = useState<Record<number, Presence>>({});
  const [view, setView] = useState<"home" | "menu" | "chats" | "people" | "mail" | "approval" | "todos">("chats");
  const [showSettings, setShowSettings] = useState(false);
  const [focused, setFocused] = useState(document.hasFocus());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [portalBadge, setPortalBadge] = useState({ approval: 0, noti: 0, mail: 0 });
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeKey;

  const toast = useCallback((text: string, kind: Toast["kind"] = "error", action?: Toast["action"]) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 5500 : 4500);
  }, []);

  // theme
  useEffect(() => {
    if (!settings) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = settings.theme === "dark" || (settings.theme === "system" && mq.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      document.documentElement.style.setProperty("--fs", `${settings.fontSize || 14}px`);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [settings]);

  // boot: settings + existing session + auto-login
  useEffect(() => {
    (async () => {
      const s = await api().call<Settings>("settings:get");
      setSettings(s);
      document.documentElement.dataset.platform = api().platform;
      const st = await api().call<{ user: SessionUser | null; conn: ConnState }>("auth:state");
      if (st.user) {
        setUser(st.user);
        setConn(st.conn);
        setRooms(await api().call("rooms:list"));
      } else if (s.autoLogin && s.hasSavedPassword && s.username) {
        try {
          const u = await api().call<SessionUser>("auth:login", {
            serverUrl: s.serverUrl, username: s.username, rememberMe: true, autoLogin: true,
          });
          setUser(u);
        } catch (e) {
          toast(`자동 로그인 실패: ${(e as Error).message}`);
        }
      }
      setBooting(false);
    })();
  }, [toast]);

  // core events
  useEffect(() => {
    const offs = [
      api().onEvent(({ type, payload }) => {
        if (type === "rooms") setRooms(payload);
        else if (type === "connection") setConn(payload.state);
        else if (type === "presence") setPresence((p) => ({ ...p, [payload.userId]: payload.presence }));
        else if (type === "ready") setUser(payload);
        else if (type === "portalBadge") setPortalBadge(payload);
        else if (type === "loggedOut") {
          setUser(null);
          setRooms([]);
          setActiveKey(null);
        } else if (type === "todo") {
          const p = payload;
          if (p?.type === "auto" && p.item) {
            const id = p.item.id as string;
            toast(`할일 자동 등록: ${p.item.title}`, "info", {
              label: "실행 취소",
              onClick: () => void api().call("todo:undoAuto", id),
            });
          } else if (p?.type === "suggest") {
            toast("할일로 추가할까요? — 할일 탭에서 확인", "info");
          }
        }
        window.dispatchEvent(new CustomEvent("ubion:event", { detail: { type, payload } }));
      }),
      api().onOpenRoom((key) => {
        setView("chats");
        setActiveKey(key);
      }),
      api().onOpenSettings(() => setShowSettings(true)),
      api().onFocus(setFocused),
      api().onBadge(async (n) => {
        if (api().platform === "win32") await api().call("app:badgeOverlay", n ? drawBadge(n) : null);
      }),
    ];
    const on = () => setNetOnline(true);
    const off = () => setNetOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      offs.forEach((o) => o());
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    if (user) api().call("org:presence").then(setPresence).catch(() => undefined);
  }, [user, conn]);

  // Home tab visible + window focused → fast portal polling; otherwise light background set
  useEffect(() => {
    if (user) api().portal.setActive(view === "home" && focused).catch(() => undefined);
  }, [user, view, focused]);
  useEffect(() => {
    if (user) api().portal.get().then((s: any) => s?.badge && setPortalBadge(s.badge)).catch(() => undefined);
  }, [user]);

  useEffect(() => {
    api().call("rooms:setActive", activeKey).catch(() => undefined);
  }, [activeKey]);

  // keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === ",") {
        e.preventDefault();
        setShowSettings(true);
      } else if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setView("chats");
        document.getElementById("room-filter")?.focus();
      } else if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setView("people");
      } else if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        const idx = rooms.findIndex((r) => r.key === activeRef.current);
        const next = rooms[Math.max(0, Math.min(rooms.length - 1, idx + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next) setActiveKey(next.key);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [rooms]);

  const activeRoom = useMemo(() => rooms.find((r) => r.key === activeKey) || null, [rooms, activeKey]);
  const totalUnread = rooms.reduce((n, r) => n + r.unread, 0);
  const homeBadge = portalBadge.approval + portalBadge.noti;

  useEffect(() => {
    document.title = totalUnread ? `(${totalUnread}) UBION Messenger` : "UBION Messenger";
  }, [totalUnread]);

  if (booting || !settings) return <div className="splash"><div className="logo-mark big">U</div></div>;

  if (!user)
    return (
      <>
        <Login
          settings={settings}
          onLoggedIn={async (u) => {
            setUser(u);
            setSettings(await api().call("settings:get"));
          }}
        />
        <Toasts toasts={toasts} />
      </>
    );

  const offline = !netOnline || conn === "reconnecting" || conn === "offline";

  return (
    <div className="app">
      <nav className="rail">
        <div className="rail-drag" />
        <div className="logo-mark" title="UBION Messenger">U</div>
        <button className={`rail-btn ${view === "home" ? "on" : ""}`} title="홈" onClick={() => setView("home")}>
          <Icon name="home" />
          {homeBadge > 0 && <span className="rail-badge">{homeBadge > 99 ? "99+" : homeBadge}</span>}
        </button>
        <button className={`rail-btn ${view === "mail" ? "on" : ""}`} title="메일" onClick={() => setView("mail")}>
          <Icon name="mail" />
        </button>
        <button className={`rail-btn ${view === "approval" ? "on" : ""}`} title="전자결재" onClick={() => setView("approval")}>
          <Icon name="approval" />
          {portalBadge.approval > 0 && <span className="rail-badge">{portalBadge.approval > 99 ? "99+" : portalBadge.approval}</span>}
        </button>
        <button className={`rail-btn ${view === "menu" ? "on" : ""}`} title="메뉴 (DaouOffice 전체 기능)" onClick={() => setView("menu")}>
          <Icon name="grid" />
        </button>
        <button className={`rail-btn ${view === "chats" ? "on" : ""}`} title="대화 (⌘K)" onClick={() => setView("chats")}>
          <Icon name="chat" />
          {totalUnread > 0 && <span className="rail-badge">{totalUnread > 99 ? "99+" : totalUnread}</span>}
        </button>
        <button className={`rail-btn ${view === "todos" ? "on" : ""}`} title="할일" onClick={() => setView("todos")}>
          <Icon name="todo" />
        </button>
        <button className={`rail-btn ${view === "people" ? "on" : ""}`} title="조직도 (⌘N)" onClick={() => setView("people")}>
          <Icon name="people" />
        </button>
        <div className="rail-spacer" />
        <button className="rail-btn" title="설정 (⌘,)" onClick={() => setShowSettings(true)}>
          <Icon name="gear" />
        </button>
        <div className="rail-me" title={user.name}>
          <Avatar name={user.name} src={user.thumbnail} size={32} presence={conn === "online" ? "online" : "offline"} />
        </div>
      </nav>
      <div className="main">
        <UpdateBanner />
        {offline && (
          <div className={`banner ${!netOnline ? "bad" : "warn"}`}>
            {!netOnline
              ? "오프라인 상태입니다. 네트워크 연결을 확인하세요."
              : conn === "reconnecting"
              ? "실시간 연결이 끊어져 다시 연결하는 중…"
              : "실시간 서버에 연결하는 중…"}
          </div>
        )}
        <div className="panes">
          {view === "mail" ? (
            <Mail />
          ) : view === "approval" ? (
            <Approval />
          ) : view === "todos" ? (
            <Todos
              rooms={rooms}
              toast={(m) => toast(m, "info")}
              onOpenSource={(roomKey) => {
                setActiveKey(roomKey);
                setView("chats");
              }}
            />
          ) : (
            <>
              {view === "home" ? (
                <Home onLocal={setView} />
              ) : view === "menu" ? (
                <Menu badge={portalBadge} unreadChats={totalUnread} onLocal={setView} />
              ) : view === "chats" ? (
                <Sidebar rooms={rooms} activeKey={activeKey} presence={presence} onOpen={setActiveKey} />
              ) : (
                <People
                  presence={presence}
                  me={user}
                  toast={toast}
                  onOpenRoom={(k) => {
                    setActiveKey(k);
                    setView("chats");
                  }}
                />
              )}
              {view === "home" || view === "menu" ? null : activeRoom ? (
                <ChatView
                  key={activeRoom.key}
                  room={activeRoom}
                  me={user}
                  focused={focused}
                  presence={activeRoom.peerUserId ? presence[activeRoom.peerUserId] : undefined}
                  toast={toast}
                />
              ) : (
                <div className="empty-chat">
                  <div className="logo-mark big">U</div>
                  <h2>UBION Messenger</h2>
                  <p>왼쪽에서 대화를 선택하거나 조직도에서 동료를 찾아 대화를 시작하세요.</p>
                  <p className="muted small">⌘/Ctrl+K 대화 검색 · ⌘/Ctrl+N 조직도 · Alt+↑↓ 대화 이동</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {showSettings && (
        <SettingsModal
          settings={settings}
          user={user}
          onChange={setSettings}
          onClose={() => setShowSettings(false)}
          onLogout={async () => {
            await api().call("auth:logout");
            setShowSettings(false);
            setUser(null);
            setRooms([]);
            setActiveKey(null);
            setPortalBadge({ approval: 0, noti: 0, mail: 0 });
            setSettings(await api().call("settings:get"));
          }}
        />
      )}
      <Toasts toasts={toasts} />
    </div>
  );
}

function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind || ""}`}>
          <span>{t.text}</span>
          {t.action && (
            <button className="link small" style={{ marginLeft: 10, color: "#fff" }} onClick={t.action.onClick}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

