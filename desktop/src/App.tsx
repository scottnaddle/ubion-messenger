import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ConnState, type LockStatus, type Person, type Presence, type Room, type SessionUser, type Settings } from "./api";
import { Login } from "./components/Login";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { People } from "./components/People";
import { SettingsModal } from "./components/SettingsModal";
import { GlobalSearch } from "./components/GlobalSearch";
import { drawBadge } from "./lib/badge";
import { applySavedLanguage, useT, type I18nCaps } from "./lib/i18n";
import { Avatar, Icon } from "./components/ui";
import { RailButton, RailProfile } from "./components/RailTooltip";
import { UpdateBanner } from "./components/UpdateBanner";
import { Home } from "./components/Home";
import { Menu } from "./components/Menu";
import { SavedMessages } from "./components/SavedMessages";
import { Mail } from "./components/Mail";
import { Approval } from "./components/Approval";
import { LockScreen } from "./components/LockScreen";
import { Flex } from "./components/Flex";
import { noticeStoreKey } from "../electron/core/room-notice";
import { isBotAuthDm } from "./lib/markers";
import { THEME_STYLE_ID } from "../electron/core/theme";
import { navForDigit, type NavView } from "./nav";
import {
  applyBotStatus, BOT_STATUS_TTL_MS, clearBotStatusForMessage, expireBotStatuses, type BotStatusMap,
} from "./lib/bot-status";
import { isTypingTarget, matchShortcut } from "./lib/shortcuts";
import type { PaletteItem } from "./lib/palette";
import { CommandPalette } from "./components/CommandPalette";
import { isMobileUi, useIsCompact } from "./lib/compact";
import { ShortcutsHelp } from "./components/ShortcutsHelp";

export type ToastAction = { label: string; run: () => void };
export type Toast = { id: number; text: string; kind?: "error" | "info"; action?: ToastAction };
export type ToastFn = (text: string, kind?: Toast["kind"], action?: ToastAction) => void;

export function App() {
  const t = useT();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [botUserSeq, setBotUserSeq] = useState(0);
  const [booting, setBooting] = useState(true);
  /** Set when the account needs the web-login window (OTP / 2-step) — at boot or on session expiry. */
  const [webPrompt, setWebPrompt] = useState("");
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnState>("offline");
  const [netOnline, setNetOnline] = useState(navigator.onLine);
  const [presence, setPresence] = useState<Record<number, Presence>>({});
  const [statusMessages, setStatusMessages] = useState<Record<number, string>>({});
  const [botStatuses, setBotStatuses] = useState<BotStatusMap>({});
  const [view, setView] = useState<NavView | "approval">("chats");
  const [showSettings, setShowSettings] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [globalSearch, setGlobalSearch] = useState<{ keyword: string } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [orgUsers, setOrgUsers] = useState<Person[]>([]);
  const [lockStatus, setLockStatus] = useState<LockStatus | null>(null);
  const [focused, setFocused] = useState(document.hasFocus());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [portalBadge, setPortalBadge] = useState({ approval: 0, noti: 0, mail: 0 });
  const [flexPending, setFlexPending] = useState<number | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeKey;
  /** Capacitor build: portal views (home/mail/flex/apps/approval) are not ported; phones get a single pane. */
  const mobileUi = isMobileUi();
  const compact = useIsCompact();
  useEffect(() => {
    if (mobileUi && view !== "chats" && view !== "people") setView("chats");
  }, [mobileUi, view]);

  const toast = useCallback((text: string, kind: Toast["kind"] = "error", action?: ToastAction) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 7000 : 4500);
  }, []);

  // 다국어: module-level language drives useT() in every component; always ko unless main reports UBM_I18N=1
  const [i18nOn, setI18nOn] = useState(false);
  useEffect(() => {
    api().call<I18nCaps>("i18n:caps").then((c) => setI18nOn(!!c?.enabled)).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (settings) applySavedLanguage(settings.language, i18nOn);
  }, [settings?.language, i18nOn]);

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

  // color preset + 테마 업로드: active custom CSS goes in a <style> appended after styles.css so it wins the cascade.
  const preset = settings?.themePreset || "default";
  const activeThemeId = settings?.activeThemeId || "";
  useEffect(() => {
    if (preset === "default") delete document.documentElement.dataset.preset;
    else document.documentElement.dataset.preset = preset;
  }, [preset]);
  useEffect(() => {
    let cancelled = false;
    const load = activeThemeId ? api().theme.css(activeThemeId).catch(() => "") : Promise.resolve("");
    void load.then((css) => {
      if (cancelled) return;
      let el = document.getElementById(THEME_STYLE_ID);
      if (!css) return el?.remove();
      if (!el) el = document.createElement("style");
      el.id = THEME_STYLE_ID;
      el.textContent = css;
      document.head.appendChild(el); // (re)append: stays last even if other styles were added since
    });
    return () => { cancelled = true; };
  }, [activeThemeId]);

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
          const u = await api().call<SessionUser | { webLoginRequired: true; message: string }>("auth:login", {
            serverUrl: s.serverUrl, username: s.username, rememberMe: true, autoLogin: true,
          });
          if ("webLoginRequired" in u) setWebPrompt(u.message.split("\n")[0]);
          else setUser(u);
        } catch (e) {
          toast(t("자동 로그인 실패: {message}", { message: (e as Error).message }));
        }
      }
      setBooting(false);
    })();
  }, [toast]);

  // Known bot userSeq for safe auth-DM hiding; 0/unknown = hide nothing.
  useEffect(() => {
    let alive = true;
    if (!user) {
      setBotUserSeq(0);
      return;
    }
    api().call<number>("auth:botUserSeq").then((n) => {
      if (alive) setBotUserSeq(Number(n) || 0);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [user?.id]);

  // messenger lock state (main owns the actual lock)
  useEffect(() => {
    let alive = true;
    api().call<LockStatus>("lock:status").then((s) => { if (alive) setLockStatus(s); }).catch(() => undefined);
    const off = api().onLockChanged((s) => {
      setLockStatus((prev) => prev ? { ...prev, ...s } : { enabled: true, locked: !!s.locked, timeoutMin: 0 });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  // core events
  useEffect(() => {
    const offs = [
      api().onEvent(({ type, payload }) => {
        if (type === "roomNotice") {
          const key = payload?.notice?.messageId != null ? noticeStoreKey(payload.notice.messageId) : "";
          if (key) localStorage.setItem(key, "normal");
        } else if (type === "rooms") setRooms(payload);
        else if (type === "connection") setConn(payload.state);
        else if (type === "presence") {
          setPresence((p) => ({ ...p, [payload.userId]: payload.presence }));
          setStatusMessages((m) => {
            const next = { ...m };
            if (payload.statusMessage) next[payload.userId] = payload.statusMessage;
            else delete next[payload.userId];
            return next;
          });
        }
        else if (type === "botStatus") setBotStatuses((m) => applyBotStatus(m, payload, Date.now()));
        else if (type === "message" && !payload.attachUpdate) {
          setBotStatuses((m) => clearBotStatusForMessage(m, payload.roomKey, Number(payload.sendUserSeq)));
        } else if (type === "ready") setUser(payload);
        else if (type === "portalBadge") setPortalBadge(payload);
        else if (type === "webLoginRequired") {
          // Web (OTP) session expired: back to login with the web-login prompt; never loop native logins.
          setWebPrompt(payload?.message || t("이 계정은 추가 인증(OTP)이 필요해요"));
          setUser(null);
          setRooms([]);
          setActiveKey(null);
        } else if (type === "loggedOut") {
          setUser(null);
          setRooms([]);
          setActiveKey(null);
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
  useEffect(() => {
    if (user) api().status.presenceStatus().then(setStatusMessages).catch(() => undefined);
  }, [user]);

  // bot status timeout: 60s after the last update
  useEffect(() => {
    const next = Object.values(botStatuses).reduce(
      (soonest, entry) => Math.min(soonest, entry.at + BOT_STATUS_TTL_MS),
      Infinity,
    );
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(
      () => setBotStatuses((m) => expireBotStatuses(m, Date.now())),
      Math.max(0, next - Date.now()) + 50,
    );
    return () => clearTimeout(timer);
  }, [botStatuses]);

  // Home tab visible + window focused → fast portal polling; otherwise light background set
  useEffect(() => {
    if (user) api().portal.setActive(view === "home" && focused).catch(() => undefined);
  }, [user, view, focused]);
  useEffect(() => {
    if (user) api().portal.get().then((s: any) => s?.badge && setPortalBadge(s.badge)).catch(() => undefined);
  }, [user]);
  useEffect(() => {
    if (!user) return;
    api().portal.flexPending(view === "flex").then((r) => setFlexPending(r.count)).catch(() => setFlexPending(null));
  }, [user, view]);

  useEffect(() => {
    api().call("rooms:setActive", activeKey).catch(() => undefined);
  }, [activeKey]);

  // keyboard shortcuts (see src/lib/shortcuts.ts for the keymap)
  useEffect(() => {
    const stepRoom = (dir: number) => {
      const idx = rooms.findIndex((r) => r.key === activeRef.current);
      const next = rooms[Math.max(0, Math.min(rooms.length - 1, idx + dir))];
      if (next) setActiveKey(next.key);
    };
    const nextUnread = () => {
      if (!rooms.length) return;
      const idx = rooms.findIndex((r) => r.key === activeRef.current);
      const start = idx < 0 ? 0 : idx + 1;
      for (let i = 0; i < rooms.length; i++) {
        const r = rooms[(start + i) % rooms.length];
        if (r.unread > 0) return setActiveKey(r.key);
      }
    };
    const h = (e: KeyboardEvent) => {
      const action = matchShortcut(e);
      if (!action) return;
      // The palette toggle (⌘/Ctrl+K) works even while typing; everything else
      // is ignored inside inputs/textarea/select/contenteditable.
      if (action !== "palette" && isTypingTarget(e.target)) return;
      e.preventDefault();
      switch (action) {
        case "palette": setPaletteOpen((v) => !v); break;
        case "settings": setShowSettings(true); break;
        case "globalSearch": setGlobalSearch({ keyword: "" }); break;
        case "roomSearch": setView("chats"); document.getElementById("room-filter")?.focus(); break;
        case "people": setView("people"); break;
        case "nextUnread": nextUnread(); break;
        case "prevRoom": stepRoom(-1); break;
        case "nextRoom": stepRoom(1); break;
        case "shortcutsHelp": setShowShortcuts((v) => !v); break;
        default: {
          const v = navForDigit(action.slice(4));
          if (v) setView(v);
        }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [rooms]);

  // command palette people: fetch the org once, lazily, the first time it opens
  useEffect(() => {
    if (!paletteOpen || orgUsers.length) return;
    api().call<Person[]>("org:users").then(setOrgUsers).catch(() => setOrgUsers([]));
  }, [paletteOpen, orgUsers.length]);

  const paletteItems: PaletteItem[] = [
    { id: "view:chats", kind: "screen", label: t("메시지"), icon: "chat", view: "chats" },
    { id: "view:people", kind: "screen", label: t("조직도"), icon: "people", view: "people" },
    { id: "view:mail", kind: "screen", label: t("메일"), icon: "mail", view: "mail" },
    { id: "view:approval", kind: "screen", label: t("전자결재"), icon: "approval", view: "approval" },
    { id: "view:flex", kind: "screen", label: t("플렉스"), icon: "flex", view: "flex" },
    { id: "view:home", kind: "screen", label: t("홈"), icon: "home", view: "home" },
    { id: "view:menu", kind: "screen", label: t("앱"), icon: "grid", view: "menu" },
    { id: "action:settings", kind: "action", label: t("설정"), icon: "gear", keywords: "settings 단축키" },
    { id: "action:globalSearch", kind: "action", label: t("전체 대화 검색"), icon: "search", keywords: "global search" },
    ...rooms.map((r) => ({
      id: `room:${r.key}`, kind: "room" as const, label: r.name,
      sublabel: r.preview && !isBotAuthDm({
        text: r.preview, roomKind: r.kind, senderSeq: r.peerUserId, botUserSeq,
      }) ? r.preview : undefined,
      roomKey: r.key, icon: "chat", unread: r.unread,
    })),
    ...orgUsers
      .filter((u) => u.userId !== user?.id)
      .map((u) => ({
        id: `person:${u.userId}`, kind: "person" as const, label: u.name, sublabel: u.position || undefined,
        userId: u.userId, icon: "people",
      })),
  ];

  const pickPalette = (item: PaletteItem) => {
    if (item.kind === "room" && item.roomKey) {
      setView("chats");
      setActiveKey(item.roomKey);
    } else if (item.kind === "person" && item.userId != null) {
      api().call<{ key: string }>("rooms:openDirect", item.userId)
        .then((room) => { setView("chats"); setActiveKey(room.key); })
        .catch((e) => toast(e.message));
    } else if (item.id === "action:settings") {
      setShowSettings(true);
    } else if (item.id === "action:globalSearch") {
      setGlobalSearch({ keyword: "" });
    } else if (item.view) {
      setView(item.view as NavView | "approval");
    }
  };

  const activeRoom = useMemo(() => rooms.find((r) => r.key === activeKey) || null, [rooms, activeKey]);
  const totalUnread = rooms.reduce((n, r) => n + r.unread, 0);
  const homeBadge = portalBadge.approval + portalBadge.noti;

  useEffect(() => {
    document.title = totalUnread ? `(${totalUnread}) UBION Messenger` : "UBION Messenger";
  }, [totalUnread]);

  if (booting || !settings) return <div className="splash"><div className="logo-mark big">U</div></div>;

  const lockScreen = lockStatus?.locked ? (
    <LockScreen
      name={user?.name || settings.username || ""}
      onUnlocked={() => setLockStatus((s) => (s ? { ...s, locked: false } : s))}
    />
  ) : null;

  if (!user)
    return (
      <>
        <Login
          key={webPrompt}
          settings={settings}
          webPrompt={webPrompt}
          onLoggedIn={async (u) => {
            setWebPrompt("");
            setUser(u);
            setSettings(await api().call("settings:get"));
          }}
        />
        <Toasts toasts={toasts} />
        {lockScreen}
      </>
    );

  const offline = !netOnline || conn === "reconnecting" || conn === "offline";
  const compactChat = compact && view === "chats" && !!activeRoom;

  return (
    <div className={`app${compact ? " compact" : ""}${compactChat ? " compact-chat" : ""}`}>
      <nav className="rail">
        <div className="rail-drag" />
        <div className="logo-mark" title="UBION Messenger">U</div>
        {!mobileUi && (
          <RailButton id="home" active={view === "home"} onClick={() => setView("home")}>
            <Icon name="home" size={23} />
            {homeBadge > 0 && <span className="rail-badge">{homeBadge > 99 ? "99+" : homeBadge}</span>}
          </RailButton>
        )}
        <RailButton id="chats" active={view === "chats"} onClick={() => setView("chats")}>
          <Icon name="chat" size={23} />
          {totalUnread > 0 && <span className="rail-badge">{totalUnread > 99 ? "99+" : totalUnread}</span>}
        </RailButton>
        {!mobileUi && (
          <>
            <RailButton id="mail" active={view === "mail"} onClick={() => setView("mail")}>
              <Icon name="mail" size={23} />
            </RailButton>
            <RailButton id="flex" active={view === "flex"} onClick={() => setView("flex")}>
              <Icon name="flex" size={23} />
              {flexPending != null && flexPending > 0 && <span className="rail-badge">{flexPending > 99 ? "99+" : flexPending}</span>}
            </RailButton>
          </>
        )}
        <RailButton id="people" active={view === "people"} onClick={() => setView("people")}>
          <Icon name="people" size={23} />
        </RailButton>
        {!mobileUi && (
          <>
            <RailButton id="menu" active={view === "menu"} onClick={() => setView("menu")}>
              <Icon name="grid" size={23} />
            </RailButton>
            <RailButton id="approval" active={view === "approval"} onClick={() => setView("approval")}>
              <Icon name="approval" size={23} />
              {portalBadge.approval > 0 && <span className="rail-badge">{portalBadge.approval > 99 ? "99+" : portalBadge.approval}</span>}
            </RailButton>
          </>
        )}
        <div className="rail-spacer" />
        <RailButton id="settings" onClick={() => setShowSettings(true)}>
          <Icon name="gear" size={23} />
        </RailButton>
        <RailProfile name={user.name} className="rail-me">
          <Avatar name={user.name} src={user.thumbnail} size={32} presence={conn === "online" ? "online" : "offline"} />
        </RailProfile>
      </nav>
      <div className="main">
        <UpdateBanner />
        {offline && (
          <div className={`banner ${!netOnline ? "bad" : "warn"}`}>
            {!netOnline
              ? t("오프라인 상태입니다. 네트워크 연결을 확인하세요.")
              : conn === "reconnecting"
              ? t("실시간 연결이 끊어져 다시 연결하는 중…")
              : t("실시간 서버에 연결하는 중…")}
          </div>
        )}
        <div className="panes">
          {view === "mail" ? (
            <Mail />
          ) : view === "approval" ? (
            <Approval />
          ) : view === "flex" ? (
            <Flex />
          ) : (
            <>
              {view === "home" ? (
                <Home onLocal={setView} />
              ) : view === "menu" ? (
                <Menu badge={portalBadge} unreadChats={totalUnread} onLocal={setView} toast={toast} onOpenSaved={() => setSavedOpen(true)} />
              ) : view === "chats" ? (
                compactChat ? null : (
                  <Sidebar
                    rooms={rooms}
                    activeKey={activeKey}
                    presence={presence}
                    onOpen={setActiveKey}
                    toast={toast}
                    botUserSeq={botUserSeq}
                    onGlobalSearch={(keyword) => setGlobalSearch({ keyword: keyword || "" })}
                  />
                )
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
              {view === "home" || view === "menu" || (compact && !compactChat) ? null : activeRoom ? (
                <ChatView
                  key={activeRoom.key}
                  room={activeRoom}
                  me={user}
                  focused={focused}
                  presence={activeRoom.peerUserId ? presence[activeRoom.peerUserId] : undefined}
                  statusMessage={activeRoom.peerUserId ? statusMessages[activeRoom.peerUserId] : undefined}
                  botStatus={botStatuses[activeRoom.key]}
                  botUserSeq={botUserSeq}
                  toast={toast}
                  onBack={compact ? () => setActiveKey(null) : undefined}
                />
              ) : (
                <div className="empty-chat">
                  <div className="logo-mark big">U</div>
                  <h2>UBION Messenger</h2>
                  <p>{t("왼쪽에서 대화를 선택하거나 조직도에서 동료를 찾아 대화를 시작하세요.")}</p>
                  <p className="muted small">{t("⌘/Ctrl+K 명령 팔레트 · ⌘/Ctrl+Shift+F 전체 검색 · ⌘/Ctrl+/ 단축키")}</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {showSettings && (
        <SettingsModal
          settings={settings}
          i18nEnabled={i18nOn}
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
      {globalSearch && user && (
        <GlobalSearch
          rooms={rooms}
          initialKeyword={globalSearch.keyword}
          onOpenRoom={(k) => {
            setView("chats");
            setActiveKey(k);
          }}
          onClose={() => setGlobalSearch(null)}
        />
      )}
      {paletteOpen && user && (
        <CommandPalette items={paletteItems} onPick={pickPalette} onClose={() => setPaletteOpen(false)} />
      )}
      {showShortcuts && <ShortcutsHelp onClose={() => setShowShortcuts(false)} />}
      {savedOpen && user && (
        <SavedMessages
          toast={toast}
          onOpenRoom={(k) => {
            setView("chats");
            setActiveKey(k);
          }}
          onClose={() => setSavedOpen(false)}
        />
      )}
      <Toasts toasts={toasts} />
      {lockScreen}
    </div>
  );
}

function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind || ""}`}>
          {t.text}
          {t.action && <button className="toast-action" onClick={t.action.run}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}

