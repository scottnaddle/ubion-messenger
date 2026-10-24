/**
 * window.ubion for the Capacitor build: the Electron IPC surface (src/api.ts Bridge) implemented in the
 * renderer. Messaging/org/settings are real (DaouClient over CapacitorHttp); desktop-only or not-yet-ported
 * features answer with disabled caps / empty results, and actions on them reject with UNSUPPORTED.
 * Logging: unknown channel names only — never arguments, credentials or cookies.
 */
import { Capacitor } from "@capacitor/core";
import type { Bridge, Settings } from "../api";
import { HttpError } from "../../electron/core/daou-client";
import { WEB_LOGIN_MESSAGE } from "../../electron/core/web-login";
import { computeManualUntil } from "../../electron/core/dnd";
import { MobileCore, type CoreEvent } from "./core";
import { applySettingsPatch, loadMobileSettings, saveMobileSettings } from "./settings";
import { platformFetch, type HttpFetch } from "../platform/http";
import { platformStorage, type KvStore } from "../platform/storage";
import { setBadge } from "../platform/notify";

export const UNSUPPORTED = "모바일 앱에서는 아직 지원하지 않는 기능입니다";
const SERVER_UNREACHABLE = "서버에 연결할 수 없습니다. 네트워크(사내망/VPN)를 확인하세요.";

/** Same user-facing mapping as main's errMsg() (wrapped `handle` → {ok:false,error}). */
export function errMsg(e: unknown): string {
  if (e instanceof HttpError && e.status === 401 && !e.diag) return "인증이 만료되었습니다. 다시 로그인해 주세요.";
  if (e instanceof Error) {
    if (/fetch failed|failed to fetch|load failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timed out|offline|aborted/i.test(e.message + String((e as any).cause ?? "")))
      return SERVER_UNREACHABLE;
    return e.message;
  }
  return String(e);
}

const unsupported = async (): Promise<never> => {
  throw new Error(UNSUPPORTED);
};

/** Action channels that exist on desktop but are not ported yet: reject with a readable message. */
const UNSUPPORTED_CHANNELS = new Set([
  "auth:webLogin", "rooms:createGroup", "rooms:setPush",
  "files:sendPaths", "files:sendBuffer", "files:pick", "files:pickForStaging", "files:download", "files:save",
  "file:preview", "capture:start", "msg:delete", "msg:forwardRoom", "msg:forwardMembers", "room:notice",
  "msg:edit", "msg:reply", "history:clear", "lock:setPin", "lock:disable", "lock:lockNow",
  "bot:roomSettings:set", "theme:import", "update:check", "update:download", "update:install",
]);

export type MobileBridgeOptions = {
  fetch?: HttpFetch;
  storage?: KvStore;
  platform?: string;
  pollMs?: number;
  version?: string;
  /** Test seam (defaults to a real MobileCore). */
  core?: MobileCore;
  /** Visibility source for foreground polling (defaults to document). */
  doc?: Document;
};

export type MobileBridge = { bridge: Bridge; core: MobileCore; dispose(): void };

export function createMobileBridge(opts: MobileBridgeOptions = {}): MobileBridge {
  const storage = opts.storage ?? platformStorage();
  const core = opts.core ?? new MobileCore({ fetch: opts.fetch ?? platformFetch(), pollMs: opts.pollMs });
  const platform = opts.platform ?? Capacitor.getPlatform();
  const version = opts.version ?? String(import.meta.env?.VITE_APP_VERSION ?? "dev");
  const doc = opts.doc ?? (typeof document !== "undefined" ? document : undefined);

  let settings: Settings | null = null;
  const loadSettings = async () => (settings ??= await loadMobileSettings(storage));
  const persist = async (s: Settings) => {
    settings = s;
    await saveMobileSettings(storage, s);
    return s;
  };

  const eventSubs = new Set<(e: CoreEvent) => void>();
  const focusSubs = new Set<(f: boolean) => void>();
  const badgeSubs = new Set<(n: number) => void>();
  const sub = <T>(set: Set<T>) => (cb: T) => {
    set.add(cb);
    return () => void set.delete(cb);
  };

  const offCore = core.on((e) => {
    for (const cb of [...eventSubs]) cb(e);
    if (e.type === "rooms") {
      const n = core.unreadTotal();
      setBadge(n, doc);
      for (const cb of [...badgeSubs]) cb(n);
    }
  });

  const onVisibility = () => {
    const fg = doc?.visibilityState !== "hidden";
    core.setForeground(fg);
    for (const cb of [...focusSubs]) cb(fg);
  };
  doc?.addEventListener("visibilitychange", onVisibility);

  const roomOf = (key: unknown) => {
    const room = core.getRooms().find((r) => r.key === key);
    if (!room) throw new Error("알 수 없는 대화방입니다");
    return room;
  };

  const handlers: Record<string, (...a: any[]) => unknown> = {
    "app:info": () => ({ version, platform, encryption: false }),
    "i18n:caps": () => ({ enabled: false }),
    "settings:get": async () => ({ ...(await loadSettings()), hasSavedPassword: false }),
    "settings:set": async (input: Partial<Settings>) => persist(applySettingsPatch(await loadSettings(), input)),
    "settings:pickDownloadDir": () => null,

    "auth:state": () => ({ user: core.user, conn: core.conn }),
    "auth:botUserSeq": () => 0,
    "auth:login": async (o: { serverUrl?: string; username?: string; password?: string; rememberMe?: boolean; autoLogin?: boolean }) => {
      const s = await loadSettings();
      const username = String(o?.username ?? "").trim();
      const serverUrl = String(o?.serverUrl || s.serverUrl).trim().replace(/\/$/, "");
      if (!/^https?:\/\//.test(serverUrl)) throw new Error("서버 주소는 https:// 로 시작해야 합니다");
      // No saved password on mobile yet (TODO keychain): a password must be typed every time.
      const password = o?.password;
      if (!password) throw new Error("비밀번호를 입력하세요");
      const rememberMe = !!o?.rememberMe;
      try {
        const user = await core.login({ serverUrl, username, password });
        await persist({ ...s, serverUrl, username, rememberMe, autoLogin: rememberMe && !!o?.autoLogin, hasSavedPassword: false });
        return user;
      } catch (e) {
        if (e instanceof HttpError && e.webLogin) {
          await persist({ ...s, serverUrl, username, rememberMe, autoLogin: false, hasSavedPassword: false });
          return { webLoginRequired: true, message: e.message || WEB_LOGIN_MESSAGE };
        }
        throw e;
      }
    },
    "auth:logout": async () => {
      await core.logout("user");
      const s = await loadSettings();
      await persist({ ...s, autoLogin: false });
    },
    "lock:status": () => ({ enabled: false, locked: false, timeoutMin: 0 }),
    "lock:unlock": () => ({ ok: true }),

    "rooms:list": () => core.getRooms(),
    "rooms:refresh": () => core.refreshRooms(),
    "rooms:sync": () => core.sync("manual"),
    "rooms:setActive": (key: string | null) => core.setActiveRoom(key ?? null),
    "rooms:pin": (key: string, pin: boolean) => core.setPin(key, !!pin),
    "rooms:members": (key: string) => core.members(key),
    "rooms:openDirect": (userId: number) => core.openDirect(Number(userId)),
    "msg:history": async (key: string, before?: number) => {
      roomOf(key);
      const list = await core.history(key, before);
      core.noteSeen(key, list);
      return list;
    },
    "msg:send": (key: string, text: string) => {
      roomOf(key);
      return core.sendText(key, String(text));
    },
    "msg:markRead": (key: string, mid?: number) => core.markRead(key, mid),
    "msg:search": (key: string, kw: string) => core.searchInRoom(key, String(kw ?? "")),
    "org:users": (force?: boolean) => core.users(!!force),
    "org:departments": () => core.departments(),
    "org:presence": () => ({}),
    "favorites:list": () => core.client.listFavorites(),

    "bot:roomSettings:get": () => ({ ok: false, kind: "unavailable", message: UNSUPPORTED }),
    "link:preview": () => null,
    "link:image": () => null,
    "files:showInFolder": () => undefined,
    "app:openExternal": (url: string) => {
      if (typeof url === "string" && /^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener");
    },
    "app:badgeOverlay": () => undefined,
    "app:openChatBot": () => undefined,
    "update:status": () => ({ state: "idle", current: version, supported: false, platform }),
    "update:openPage": () => undefined,
    "dnd:manual": async (hours: unknown) => {
      const manualUntil = computeManualUntil(Date.now(), hours);
      await persist({ ...(await loadSettings()), dndManualUntil: manualUntil });
      return { manualUntil };
    },
    "search:cacheInfo": () => ({ docs: 0 }),
  };

  async function call<T = any>(ch: string, ...args: unknown[]): Promise<T> {
    const h = handlers[ch];
    if (!h) {
      if (UNSUPPORTED_CHANNELS.has(ch)) throw new Error(UNSUPPORTED);
      console.warn(`[ubm-mobile] unhandled channel: ${ch}`);
      return undefined as T;
    }
    try {
      return (await h(...args)) as T;
    } catch (e) {
      throw new Error(errMsg(e));
    }
  }

  const emptyTheme = { themes: [], activeThemeId: "" };
  const bridge: Bridge = {
    call,
    deleteChatMessages: unsupported,
    forwardToRoom: unsupported,
    forwardToMembers: unsupported,
    registerNotice: unsupported,
    setRoomPush: unsupported,
    previewFile: unsupported,
    captureScreen: unsupported,
    backup: {
      config: async () => ({ historyClearEnabled: false }),
      request: unsupported,
      list: async () => [],
      download: unsupported,
      remove: unsupported,
      clearHistory: unsupported,
    },
    pubsub: {
      caps: async () => ({ send: false, delete: false, selfOnly: false, reason: UNSUPPORTED }),
      list: async (page = 0) => ({ items: [], total: 0, page, hasMore: false }),
      detail: unsupported,
      send: unsupported,
      remove: unsupported,
    },
    zoom: {
      caps: async () => ({ enabled: false, configured: false, flowVerified: false, connected: false, reason: UNSUPPORTED }),
      connect: unsupported,
      createMeeting: unsupported,
    },
    theme: {
      list: async () => emptyTheme,
      import: async () => null,
      remove: async () => emptyTheme,
      activate: async () => emptyTheme,
      css: async () => "",
    },
    search: {
      caps: async () => ({ server: false, dateRange: false, maxRooms: 0, localEngine: "none" }),
      global: async (searchId) => ({ searchId, hits: [], searchedRooms: 0, totalRooms: 0, failedRooms: 0, cancelled: false, serverSearched: false }),
      cancel: async () => undefined,
      cacheInfo: async () => ({ docs: 0 }),
      clearCache: async () => ({ docs: 0 }),
      onProgress: () => () => undefined,
    },
    listFavorites: () => call("favorites:list"),
    addFavorite: unsupported,
    removeFavorite: unsupported,
    saved: { list: async () => [], add: unsupported, remove: async () => ({ ok: true as const }) },
    reminders: { list: async () => [], add: unsupported, remove: async () => ({ ok: true as const }) },
    scheduled: { list: async () => [], add: unsupported, cancel: async () => ({ ok: true as const }), sendNow: unsupported },
    dnd: { manual: (hours) => call("dnd:manual", hours) },
    status: {
      caps: async () => ({ xmpp: false, server: false }),
      get: async () => ({ text: null }),
      set: unsupported,
      presenceStatus: async () => ({}),
    },
    reactions: { caps: async () => ({ enabled: false }), list: async () => ({}), toggle: unsupported },
    polls: { caps: async () => ({ enabled: false, selfOnly: false }), create: unsupported, get: unsupported, vote: unsupported, close: unsupported },
    edit: { caps: async () => ({ enabled: false, selfOnly: false }), edit: unsupported, reply: unsupported },
    botSummary: { caps: async () => ({ enabled: false, selfOnly: false }), request: unsupported },
    openChatBot: async () => undefined,
    onEvent: sub(eventSubs),
    onOpenRoom: () => () => undefined,
    onOpenSettings: () => () => undefined,
    onFocus: sub(focusSubs),
    onBadge: sub(badgeSubs),
    onLockChanged: () => () => undefined,
    onUpdate: () => () => undefined,
    portal: {
      get: async () => null,
      refresh: async () => null,
      open: async (url: string) => void call("app:openExternal", url),
      setActive: async () => undefined,
      menu: async () => ({ items: [], source: "static" as const }),
      mailFolders: unsupported,
      mailList: unsupported,
      mailRead: unsupported,
      approvalList: unsupported,
      approvalCounts: async () => ({ todo: 0, upcoming: 0 }),
      approvalDoc: unsupported,
      mailUpload: unsupported,
      mailCaps: async () => ({ delete: false }),
      mailDelete: unsupported,
      mailSend: unsupported,
      approvalAction: unsupported,
      flexPending: async () => ({ count: null, at: Date.now(), error: UNSUPPORTED }),
    },
    pathForFile: () => "",
    platform,
  };

  return {
    bridge,
    core,
    dispose() {
      offCore();
      doc?.removeEventListener("visibilitychange", onVisibility);
      core.stopPolling();
    },
  };
}

/** Install window.ubion for the mobile build (no-op if a bridge already exists, e.g. the mock). */
export function installMobileBridge(opts?: MobileBridgeOptions): MobileBridge | null {
  if ((window as any).ubion) return null;
  const mb = createMobileBridge(opts);
  (window as any).ubion = mb.bridge;
  return mb;
}
