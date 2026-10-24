import { resolveSaveTarget, type SaveMode } from "./core/save-path";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  session,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import type { WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import { MessengerCore } from "./core/messenger";
import { fetchLinkPreview, fetchPreviewImage, PreviewCache } from "./core/link-preview";
import { MediaCache } from "./core/media-cache";
import { Updater } from "./updater";
import { HttpError } from "./core/daou-client";
import type { ChatMessage, MessengerEventMap } from "./core/types";
import { isPortalUrl, isFlexUrl, isFlexSsoUrl, toElectronCookie } from "./core/portal-cookies";
import {
  isFlexLoginUrl, flexEmailFromUsername, flexAutoLoginScript, maskFlexLog,
  FLEX_TODO_SEARCH, FLEX_TODO_PENDING_BODY, parseFlexTodoTotal, flexProgressCountFromText,
} from "./core/flex";
import { normalizeApprovalDocId, normalizeApprovalListArgs } from "./core/portal";
import { shouldNotify } from "./core/room-push";
import { apiRoomSeq, checkForwardTarget } from "./core/forward";
import { backupFileName, historyClearEnabled, normalizeBackupFileType } from "./core/backup";
import { checkPubsubDelete, checkPubsubSend, pubsubCaps, pubsubSendEnabled, PUBSUB_SEND_DISABLED_TEXT } from "./core/pubsub";
import { maskSecrets } from "./core/mask";
import {
  createRateLimiter, DEFAULT_CONCURRENCY, DEFAULT_MIN_INTERVAL_MS, globalSearchCaps, runGlobalSearch,
} from "./core/global-search";
import { SearchCacheStore } from "./core/search-cache";
import { normalizeSavedInput, SavedStore } from "./core/saved";
import { dueReminders, nextDueAt, normalizeReminderInput, ReminderStore, type Reminder } from "./core/reminders";
import {
  dueScheduled, guardScheduledTarget, nextScheduledAt, normalizeScheduledInput, ScheduledStore,
  type ScheduledMessage,
} from "./core/scheduled-send";
import { computeManualUntil, isInDnd, normalizeDndDays, normalizeDndMin } from "./core/dnd";
import { normalizeStatusText, statusCaps, statusServerEnabled, statusXmppEnabled } from "./core/status-message";
import { createStatusClient } from "./core/status-server";
import { redactDiag,
  createReactionsClient, guardReactionRoom, normalizeEmoji, normalizeMessageId, normalizeMessageIds, normalizeRoomSeq,
  REACTIONS_DISABLED_TEXT, reactionsEnabled,
} from "./core/reactions";
import {
  createPollsClient, guardPollRoom, normalizeOptionIndex, normalizePollId, normalizePollInput,
  pollsCaps, POLLS_DISABLED_TEXT, pollsEnabled,
} from "./core/polls";
import {
  editCaps, editEnabled, EDIT_DISABLED_TEXT, guardEditReplyTarget, normalizeEditText, normalizeReplyTarget,
  normalizeReplyText, performEdit, performReply,
} from "./core/edit-reply";
import {
  BOT_SUMMARY_DISABLED_TEXT, botSummaryCaps, botSummaryEnabled, guardBotSummaryTarget, normalizeSummaryRoomKey,
  normalizeSummaryMode, normalizeRecentN, performBotSummary,
} from "./core/bot-summary";
import { normalizeGlobalQuery } from "../src/lib/global-search";
import {
  activateTheme, addTheme, checkThemeSize, isCssFileName, newThemeId, normalizePreset, removeTheme, sanitizeThemeCss,
  themeFileName, themeNameFromPath, type ThemeState,
} from "./core/theme";
import { buildPreviewUrl, docViewerServerEnabled, docViewerTemplate, isPreviewExtension, planPreview, previewTempName, type PreviewMode } from "./core/doc-preview";
import {
  CAPTURE_OVERLAY_DONE, CAPTURE_OVERLAY_IMAGE, CAPTURE_START, captureFileName, captureOverlayUrl, capturePermissionError,
  captureScale, captureThumbnailSize, normalizeCropRect, pickScreenSource, type CaptureResult,
} from "./core/capture";
import { chatBotUrl, isChatBotUrl } from "./core/chatbot";
import {
  extractZoomRedirect, resolveZoomClientId, zoomAuthorizeUrl, zoomCaps, zoomEnabled, zoomRedirectUri, zoomState,
  ZOOM_DISABLED_TEXT, type ZoomConfig,
} from "./core/zoom";
import { isMentioningMe } from "../src/lib/mention";
import { isBotAuthDm } from "../src/lib/markers";
import { createBotSettingsClient } from "./core/bot-settings";
import { createUbmAuth, withUbmRetry, type UbmAuthToken } from "./core/ubm-auth";
import { applyMainLanguage, filterLanguagePatch, getMainLanguage, i18nCaps, tm } from "./core/i18n-main";
import { createAwayMonitor } from "./core/away";
import { createLockState, hashPin, validatePin, verifyPin, type PinRecord } from "./core/lock";
import {
  LOCK_STORAGE_UNAVAILABLE, clearLockRecord, loadLockRecord, lockStorageAvailable, saveLockRecord,
} from "./lock-store";
import { normalizeMailListArgs, normalizeMailUid, validFolder } from "./core/mail";
import { guessMime } from "./core/mime";
import {
  accountKey, isWebLoginNavAllowed, isWebLoginSuccessUrl, markWebAccount, planLogin, unmarkWebAccount,
  webLoginUrl, WEB_LOGIN_MESSAGE,
} from "./core/web-login";
import {
  clearPassword,
  loadPassword,
  loadSettings,
  savePassword,
  saveSettings,
  type Settings,
} from "./settings";
import { flavorAppId, flavorLabel, flavorProfile, normalizeServerUrl } from "./core/flavor";

const profile = flavorProfile();
/** Korean UI title (다워 / UBION Messenger). OS app name stays profile.productName. */
const APP_NAME = profile.productNameKo;
app.setName(profile.productName);
app.setPath("userData", path.join(app.getPath("appData"), profile.userDataDir));
if (process.platform === "win32") app.setAppUserModelId(flavorAppId(profile, !app.isPackaged || process.env.UBM_APP_CHANNEL === "dev"));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

protocol.registerSchemesAsPrivileged([
  { scheme: "ubion-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let settings: Settings = loadSettings();
const savedPaths = new Set<string>();
let core = new MessengerCore(settings.serverUrl);
let unsubscribe: Array<() => void> = [];
let startHidden = false;
let awayMonitor: ReturnType<typeof createAwayMonitor> | null = null;
let lockRecord: PinRecord | null = null;
// 통합 검색 로컬 캐시: <userData>/search-cache/<userSeq>.json, client-local only.
let searchCache: SearchCacheStore | null = null;
const searchIndex = () => {
  if (!searchCache) searchCache = new SearchCacheStore(path.join(app.getPath("userData"), "search-cache"), fs, { join: path.join });
  return searchCache.for(core.user?.id);
};
const indexMessages = (key: string, list: ChatMessage[]) => {
  try {
    if (searchIndex()?.add(key, list)) searchCache?.scheduleSave();
  } catch (e) {
    console.warn("search index failed:", maskSecrets(String((e as Error)?.message ?? e)));
  }
};
// 저장한 메시지 / 나중에 알림: client-local JSON under <userData>/saved|reminders/<userSeq>.json.
let savedStore: SavedStore | null = null;
const saved = () => {
  if (!savedStore) savedStore = new SavedStore(path.join(app.getPath("userData"), "saved"), fs, { join: path.join });
  return savedStore;
};
let reminderStore: ReminderStore | null = null;
const reminders = () => {
  if (!reminderStore) reminderStore = new ReminderStore(path.join(app.getPath("userData"), "reminders"), fs, { join: path.join });
  return reminderStore;
};
// 예약 전송: client-local JSON under <userData>/scheduled/<userSeq>.json, no server calls until the timer fires.
let scheduledStore: ScheduledStore | null = null;
const scheduled = () => {
  if (!scheduledStore) scheduledStore = new ScheduledStore(path.join(app.getPath("userData"), "scheduled"), fs, { join: path.join });
  return scheduledStore;
};
let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
let reminderTimer: ReturnType<typeof setTimeout> | null = null;
// 상태 메시지: XMPP text is transient (re-sent on connect); server text persists on bot.ubion.global.
let currentStatusText: string | null = null;
/** 방해 금지 시간: suppress desktop notifications/sound (badges are unaffected). */
function dndActive(): boolean {
  return isInDnd(Date.now(), {
    enabled: settings.dndEnabled,
    days: settings.dndDays,
    startMin: settings.dndStartMin,
    endMin: settings.dndEndMin,
    manualUntil: settings.dndManualUntil,
  });
}
function fireReminder(r: Reminder) {
  if (dndActive() || !Notification.isSupported()) return;
  const n = new Notification({
    title: `나중에 알림${r.roomName ? ` · ${r.roomName}` : ""}`,
    body: r.message ? r.message.slice(0, 140) : "알림 시간이 되었습니다",
    silent: !settings.notificationSound,
  });
  n.on("click", () => {
    showWindow();
    send("nav:openRoom", r.roomKey);
  });
  n.show();
}
/** Fire past-due reminders (missed while closed), then arm a timer for the next one. */
function scheduleReminderTimer() {
  if (reminderTimer) {
    clearTimeout(reminderTimer);
    reminderTimer = null;
  }
  const store = reminders();
  store.for(core.user?.id);
  const list = store.list();
  const now = Date.now();
  for (const r of dueReminders(list, now)) {
    fireReminder(r);
    store.remove(r.id);
  }
  const next = nextDueAt(list, now);
  if (next == null) return;
  reminderTimer = setTimeout(() => {
    reminderTimer = null;
    scheduleReminderTimer();
  }, Math.max(1000, next - now));
  (reminderTimer as any)?.unref?.();
}

/** The self room's API seq (used by the self-only guard). */
function selfRoomApiSeq(): number | undefined {
  const selfRoom = core.getRooms().find((r) => r.isSelf);
  if (!selfRoom) return undefined;
  try {
    return apiRoomSeq(selfRoom);
  } catch {
    return undefined;
  }
}

/** Send a scheduled message through the normal send path, with the self-only guard applied. */
async function sendScheduled(item: ScheduledMessage): Promise<void> {
  const me = core.user?.id;
  if (me == null) throw new Error("로그인이 필요합니다");
  let room = core.getRooms().find((r) => r.key === item.roomKey);
  if (!room) {
    await core.refreshRooms();
    room = core.getRooms().find((r) => r.key === item.roomKey);
  }
  guardScheduledTarget({ selfOnly: process.env.UBM_SELF_ONLY === "1", me, selfRoomSeq: selfRoomApiSeq(), room: room ?? null });
  await core.sendText(item.roomKey, item.text);
}

/**
 * Fire past-due scheduled messages, then arm a timer for the next one.
 * `startup` marks missed items (app was closed at send time) without auto-sending unless the
 * per-item "놓친 경우 앱 실행 시 전송" option is set.
 */
const scheduledInFlight = new Set<string | number>();
function armScheduledTimer(startup = false) {
  if (scheduledTimer) {
    clearTimeout(scheduledTimer);
    scheduledTimer = null;
  }
  if (core.user == null) return;
  const store = scheduled();
  store.for(core.user.id);
  const now = Date.now();
  for (const item of dueScheduled(store.list(), now)) {
    if (scheduledInFlight.has(item.id)) continue;
    if (startup && !item.sendOnMissedLaunch) {
      store.markMissed(item.id);
      continue;
    }
    scheduledInFlight.add(item.id);
    void sendScheduled(item)
      .then(() => store.remove(item.id))
      .catch((e) => {
        console.warn("scheduled send failed:", maskSecrets(String((e as Error)?.message ?? e)));
        store.markMissed(item.id);
      })
      .finally(() => scheduledInFlight.delete(item.id));
  }
  const next = nextScheduledAt(store.list(), now);
  if (next == null) return;
  scheduledTimer = setTimeout(() => {
    scheduledTimer = null;
    armScheduledTimer(false);
  }, Math.max(1000, next - now));
  (scheduledTimer as any)?.unref?.();
}

let locked = false;
const lockState = createLockState({ now: () => Date.now() });
const updater = new Updater(() => win);

const UBM_BASE_URL = () => {
  if (!profile.enhancedServer) return "";
  return (process.env.UBM_BOT_API_URL || profile.defaultBotApiUrl || "").replace(/\/$/, "");
};
const ubmTokenFile = () => path.join(app.getPath("userData"), "ubm-token.bin");

/** OS-keychain-backed persistence for the UBION token; without safeStorage the token stays in memory only. */
const ubmTokenStore = {
  async load(): Promise<UbmAuthToken | null> {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const parsed = JSON.parse(safeStorage.decryptString(fs.readFileSync(ubmTokenFile())));
      if (!parsed || typeof parsed.token !== "string" || typeof parsed.expiresAt !== "string") return null;
      const userSeq = Number(parsed.userSeq);
      if (!Number.isSafeInteger(userSeq) || userSeq <= 0) return null;
      return { token: parsed.token, userSeq, expiresAt: parsed.expiresAt };
    } catch {
      return null;
    }
  },
  async save(value: UbmAuthToken | null): Promise<void> {
    try {
      if (!safeStorage.isEncryptionAvailable()) return;
      const file = ubmTokenFile();
      if (!value) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* no saved token */
        }
        return;
      }
      fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 });
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* best effort on platforms without chmod */
      }
    } catch {
      /* persistence is best-effort; keep the token in memory */
    }
  },
};

const ubmAuth = createUbmAuth({
  baseUrl: UBM_BASE_URL(),
  getUserSeq: () => core.user?.id ?? 0,
  readBotDm: async (botUserSeq) => {
    const messages = await core.client.fetchMessages("buddy", botUserSeq, 20);
    return messages.map((m) => ({ text: m.message, senderSeq: m.sendUserSeq }));
  },
  store: ubmTokenStore,
});

/**
 * Auth proof for our server (bot.ubion.global). NEVER forward DaouOffice session cookies to it: that would hand a
 * company credential to a third host. UBM_BOT_USER_TOKEN is an explicit deployment override; otherwise use the
 * server-issued UBION token obtained through the bot DM challenge.
 */
const ubmServerProof = async (): Promise<string> => {
  const t = (process.env.UBM_BOT_USER_TOKEN || "").trim();
  if (t) return t;
  return ubmAuth.getToken();
};

const UBM_AUTH_EXPIRED = "세션이 만료되었습니다. 다시 로그인하세요.";
const isUbmAuthFailure = (r: { ok: boolean; kind?: string; message?: string }): boolean =>
  !r.ok && (r.kind === "auth" || r.message === UBM_AUTH_EXPIRED);
const retryUbm = <T>(run: () => Promise<T>, isAuth: (result: T) => boolean): Promise<T> =>
  withUbmRetry(run, () => ubmAuth.invalidate(), isAuth);

const botSettings = createBotSettingsClient({
  baseUrl: UBM_BASE_URL(),
  getUserSeq: () => core.user?.id ?? 0,
  getSessionHeader: ubmServerProof,
});

const statusClient = () => {
  const client = createStatusClient({
    baseUrl: UBM_BASE_URL(),
    getUserSeq: () => core.user?.id ?? 0,
    getSessionHeader: ubmServerProof,
  });
  return {
    get: (userSeq: number) => retryUbm(() => client.get(userSeq), isUbmAuthFailure),
    put: (userSeq: number, text: string) => retryUbm(() => client.put(userSeq, text), isUbmAuthFailure),
  };
};

const reactionsClient = () => {
  const client = createReactionsClient({
    baseUrl: UBM_BASE_URL(),
    getUserSeq: () => core.user?.id ?? 0,
    getSessionHeader: ubmServerProof,
  });
  return {
    list: (roomSeq: number, messageIds: number[]) =>
      retryUbm(() => client.list(roomSeq, messageIds), isUbmAuthFailure),
    toggle: (roomSeq: number, messageId: number, emoji: string) =>
      retryUbm(() => client.toggle(roomSeq, messageId, emoji), isUbmAuthFailure),
  };
};

const pollsClient = () => {
  const client = createPollsClient({
    baseUrl: UBM_BASE_URL(),
    getUserSeq: () => core.user?.id ?? 0,
    getSessionHeader: ubmServerProof,
  });
  return {
    create: (input: Parameters<typeof client.create>[0]) =>
      retryUbm(() => client.create(input), isUbmAuthFailure),
    get: (id: number) => retryUbm(() => client.get(id), isUbmAuthFailure),
    vote: (id: number, optionIndex: number) =>
      retryUbm(() => client.vote(id, optionIndex), isUbmAuthFailure),
    close: (id: number) => retryUbm(() => client.close(id), isUbmAuthFailure),
  };
};

const botSettingsWithRetry = {
  get: (roomId: string) => retryUbm(() => botSettings.get(roomId), isUbmAuthFailure),
  set: (roomId: string, autonomy: boolean) =>
    retryUbm(() => botSettings.set(roomId, autonomy), isUbmAuthFailure),
};

const resPath = (f: string) =>
  app.isPackaged ? path.join(process.resourcesPath, "resources", f) : path.join(__dirname, "../../resources", f);

function send(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setLocked(next: boolean) {
  if (locked === next) return;
  locked = next;
  send("lock:changed", { locked });
}

function lockNow(): boolean {
  if (!lockRecord) return false;
  lockState.reset();
  setLocked(true);
  return true;
}

function maybeAutoLock() {
  if (locked || !lockRecord || !settings.lockTimeoutMin) return;
  if (powerMonitor.getSystemIdleTime() >= settings.lockTimeoutMin * 60) lockNow();
}

function startAwayMonitor() {
  awayMonitor?.stop();
  awayMonitor = createAwayMonitor({
    getIdleSec: () => powerMonitor.getSystemIdleTime(),
    setAway: (away) => core.setAway(away),
    getConfig: () => ({ awayMinutes: settings.awayMinutes, mobileNotice: settings.mobileNotice }),
    intervalMs: 15_000,
    onTick: maybeAutoLock,
  });
  awayMonitor.start();
}

function errMsg(e: unknown): string {
  if (e instanceof HttpError && e.status === 401 && !e.diag) return "인증이 만료되었습니다. 다시 로그인해 주세요.";
  if (e instanceof Error) {
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|aborted/i.test(e.message + String((e as any).cause)))
      return "서버에 연결할 수 없습니다. 네트워크(사내망/VPN)를 확인하세요.";
    return e.message;
  }
  return String(e);
}

/** Wrap IPC handlers so errors surface as {error} instead of rejected promises with stack traces. */
function handle(channel: string, fn: (...args: any[]) => any) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });
}

function wireCore() {
  unsubscribe.forEach((u) => u());
  resetZoom();
  core.botUserSeq = () => ubmAuth.botUserSeq();
  core.allowTcpFallback = !!settings.xmppTcpFallback;
  core.portal.persistedMaxPostId = typeof settings.portalLastPostId === "number" ? settings.portalLastPostId : null;
  core.portal.onPostBaseline = (id) => {
    if (settings.portalLastPostId === id) return;
    settings = { ...settings, portalLastPostId: id };
    saveSettings(settings);
  };
  core.client.onAuthLost = () => { core.shutdown(); send("core:event", { type: "webLoginRequired", payload: { reason: "expired", message: "세션이 만료되었어요. 웹에서 다시 인증해 주세요" } }); };
  core.client.onSessionChanged = () => void syncPortalCookies().catch((e) => console.warn("portal cookie sync failed:", (e as Error).name));
  const fwd = <K extends keyof MessengerEventMap>(k: K) =>
    core.on(k, (p) => send("core:event", { type: k, payload: p }));
  unsubscribe = [
    fwd("ready"),
    fwd("rooms"),
    fwd("roomNotice"),
    fwd("message"),
    fwd("confirm"),
    fwd("receipts"),
    fwd("presence"),
    fwd("botStatus"),
    fwd("connection"),
    fwd("loggedOut"),
    fwd("portalSummary"),
    fwd("portalWidget"),
    fwd("portalBadge"),
    core.on("portalNewPost", (p) => notifyNewPost(p)),
    core.on("portalNewPostSummary", (p) => notifyNewPostSummary(p)),
    // Only while our own connect window is waiting: an unsolicited "zoom" stanza must not swap in someone else's token.
    core.on("zoomToken", (t) => { if (zoomEnabled(process.env) && zoomTokenWaiters.size) setZoomToken(t.accessToken); }),
    core.on("loggedOut", () => resetZoom()),
    core.on("rooms", () => updateBadge()),
    core.on("ready", () => scheduleReminderTimer()),
    core.on("ready", () => armScheduledTimer(true)),
    core.on("loggedOut", () => {
      if (reminderTimer) { clearTimeout(reminderTimer); reminderTimer = null; }
      if (scheduledTimer) { clearTimeout(scheduledTimer); scheduledTimer = null; }
      reminderStore?.for(null);
      scheduledStore?.for(null);
      savedStore?.for(null);
      currentStatusText = null;
    }),
    core.on("message", (m) => {
      indexMessages(m.roomKey, [m]);
      if (m.attachUpdate) return; // attach fill-in of an already-delivered file message (renderer upserts it)
      maybeNotify(m);
    }),
  ];
}

// ---------- badge / tray ----------
function updateBadge() {
  const n = core.unreadTotal();
  if (process.platform === "darwin") app.dock?.setBadge(n ? (n > 99 ? "99+" : String(n)) : "");
  else app.setBadgeCount?.(n);
  send("badge:changed", n); // renderer draws Windows overlay icon
  tray?.setToolTip(n ? `${APP_NAME} — ${tm("읽지 않은 메시지 {n}", { n })}` : APP_NAME);
  rebuildTrayMenu(n);
}

function rebuildTrayMenu(n = core.unreadTotal()) {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: n ? tm("읽지 않은 메시지 {n}개", { n }) : tm("새 메시지 없음"), enabled: false },
      { type: "separator" },
      { label: tm("{app} 열기", { app: flavorLabel(profile, getMainLanguage()) }), click: showWindow },
      { label: tm("설정"), click: () => (showWindow(), send("nav:settings", null)) },
      { type: "separator" },
      { label: tm("종료"), click: () => ((quitting = true), app.quit()) },
    ])
  );
}

/** macOS app menu; submenu titles follow settings.language (role items keep OS-localized labels). */
function buildAppMenu() {
  Menu.setApplicationMenu(
    process.platform === "darwin"
      ? Menu.buildFromTemplate([
          { role: "appMenu" },
          { role: "editMenu", label: tm("편집") },
          { role: "viewMenu", label: tm("보기") },
          { role: "windowMenu", label: tm("윈도우") },
        ])
      : null
  );
}

/** 다국어: rebuild every main-process menu after settings.language changes. */
function applyLanguage() {
  applyMainLanguage(settings.language, process.env);
  buildAppMenu();
  updateBadge();
  if (portalWin && !portalWin.isDestroyed()) portalWin.setMenu(portalNavMenu());
}

function createTray() {
  const img = nativeImage.createFromPath(resPath(process.platform === "darwin" ? "trayTemplate.png" : "tray.png"));
  if (process.platform === "darwin") img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip(APP_NAME);
  tray.on("click", showWindow);
  rebuildTrayMenu(0);
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- portal (홈) ----------
function portalUrl(rel: string): string | null {
  const base = new URL(core.client.baseUrl);
  let u: URL;
  try {
    u = new URL(rel, base);
  } catch {
    return null;
  }
  return u.origin === base.origin && /^https?:$/.test(u.protocol) ? u.toString() : null;
}

/** Open a portal deep link only on explicit user action (opening may mark items as read). */
function openPortal(rel: string, mode?: "external" | "inapp") {
  if (isFlexUrl(rel)) {
    if (!profile.flex) throw new Error("이 빌드에서는 flex를 열 수 없습니다");
    const fu = new URL(rel).toString();
    return (mode || settings.portalOpenMode) === "external" ? shell.openExternal(fu) : openPortalWindow(fu);
  }
  const url = portalUrl(rel);
  if (!url) {
    // Admin-defined custom menu links on other hosts (e.g. hrd.ubion.co.kr): OS browser only, never the SSO window.
    if (/^https?:\/\//i.test(rel) && !isPortalUrl(rel, core.client.baseUrl)) return shell.openExternal(new URL(rel).toString());
    throw new Error("허용되지 않은 주소입니다");
  }
  if ((mode || settings.portalOpenMode) === "external") return shell.openExternal(url);
  return openPortalWindow(url);
}

// ---------- in-app portal window (SSO with the messenger's GOSSOcookie) ----------
const PORTAL_PARTITION = "persist:portal";
let portalWin: BrowserWindow | null = null;
const portalSession = () => session.fromPartition(PORTAL_PARTITION);
/** Max one flex auto-login attempt per messenger session; reset on logout / successful flex landing. */
let flexAutoLoginTried = false;
let flexPendingCache: { count: number | null; at: number; error?: string } = { count: null, at: 0 };



/** Copy the core's current portal cookies (GOSSOcookie etc.) into the partition. Values are never logged. */
async function syncPortalCookies() {
  const ses = portalSession();
  if (!core.client.user) {
    await ses.clearStorageData();
    return;
  }
  const base = core.client.baseUrl;
  const cookies = await core.client.sessionCookies();
  for (const c of cookies) await ses.cookies.set(toElectronCookie(c, base));
  await ses.cookies.flushStore();
}

async function clearPortalSession() {
  if (portalWin && !portalWin.isDestroyed()) portalWin.close();
  if (docViewerWin && !docViewerWin.isDestroyed()) docViewerWin.close();
  clearPreviewTemp();
  await portalSession().clearStorageData().catch(() => undefined);
}

function portalNavMenu() {
  // Window menu bar (Windows) / app menu while focused: back, forward, reload, open in external browser.
  return Menu.buildFromTemplate([
    { label: tm("◀ 뒤로"), accelerator: "CmdOrCtrl+[", click: () => portalWin?.webContents.navigationHistory.goBack() },
    { label: tm("앞으로 ▶"), accelerator: "CmdOrCtrl+]", click: () => portalWin?.webContents.navigationHistory.goForward() },
    { label: tm("새로고침"), accelerator: "CmdOrCtrl+R", click: () => portalWin?.webContents.reload() },
    { label: tm("외부 브라우저로 열기"), click: () => { const u = portalWin?.webContents.getURL(); if (u && /^https?:/.test(u)) void shell.openExternal(u); } },
  ]);
}


async function tryFlexAutoLogin(wc: BrowserWindow["webContents"]) {
  if (!profile.flex || flexAutoLoginTried || !settings.flexAutoLogin || !settings.rememberMe) return;
  const url = wc.getURL();
  if (!isFlexLoginUrl(url)) return;
  const email = flexEmailFromUsername(settings.username, profile.flexEmailDomain);
  const password = loadPassword();
  if (!email || !password) return;
  flexAutoLoginTried = true; // one try even if fill fails
  try {
    const status = await wc.executeJavaScript(flexAutoLoginScript(email, password), true);
    if (status !== "ok") {
      console.log("[flex] auto-login skipped:", maskFlexLog(String(status)));
      return;
    }
    // Wait up to ~12s for navigation away from login; leave the page for manual login on failure.
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (wc.isDestroyed()) return;
      if (!isFlexLoginUrl(wc.getURL())) {
        void refreshFlexPending(true).catch(() => undefined);
        return;
      }
    }
    console.log("[flex] auto-login did not leave login page — manual login needed");
  } catch (e) {
    console.log("[flex] auto-login error:", maskFlexLog(String((e as Error)?.message || e)));
  }
}

function attachFlexWindowHooks(wc: WebContents) {
  const onNav = () => {
    const u = wc.getURL();
    if (isFlexLoginUrl(u)) void tryFlexAutoLogin(wc);
    else if (isFlexUrl(u) && !isFlexLoginUrl(u)) {
      void refreshFlexPending(true).catch(() => undefined);
    }
  };
  wc.on("did-finish-load", onNav);
  wc.on("did-navigate", onNav);
  wc.on("did-navigate-in-page", onNav);
}

/** Read-only JSON POST against flex (session cookies). Used only for assigned-todos/search. */
async function flexSessionPost(path: string, body: unknown): Promise<{ status: number; json: any; text: string }> {
  const ses = portalSession();
  const url = path.startsWith("http") ? path : `https://flex.team${path.startsWith("/") ? "" : "/"}${path}`;
  const res = await ses.fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

/**
 * Pending 할 일 count (= flex inbox "진행").
 * The SPA uses POST /action/v3/todo/assigned-todos/search (GET → 405); body is a status filter only (read-only).
 * Falls back to DOM "진행 (N)" scrape. Never approve/reject/modify.
 */
async function refreshFlexPending(force = false): Promise<{ count: number | null; at: number; error?: string }> {
  if (!profile.flex) return { count: null, at: Date.now(), error: "disabled" };
  if (!force && Date.now() - flexPendingCache.at < 60_000) return flexPendingCache;
  try {
    const { status, json } = await flexSessionPost(FLEX_TODO_SEARCH, FLEX_TODO_PENDING_BODY);
    const n = status >= 200 && status < 300 ? parseFlexTodoTotal(json) : null;
    if (n != null) {
      flexPendingCache = { count: n, at: Date.now() };
      return flexPendingCache;
    }
  } catch { /* fall through */ }
  const scraped = await scrapeFlexPendingFromWindow();
  if (scraped != null) {
    flexPendingCache = { count: scraped, at: Date.now() };
    return flexPendingCache;
  }
  flexPendingCache = { count: null, at: Date.now(), error: "unavailable" };
  return flexPendingCache;
}

async function scrapeFlexPendingFromWindow(): Promise<number | null> {
  if (!portalWin || portalWin.isDestroyed()) return null;
  const u = portalWin.webContents.getURL();
  if (!isFlexUrl(u) || isFlexLoginUrl(u)) return null;
  try {
    const text = await portalWin.webContents.executeJavaScript(`document.body?.innerText || ""`, true);
    return flexProgressCountFromText(String(text || ""));
  } catch {
    return null;
  }
}


// ---------- web-login fallback (OTP / 2-step accounts) ----------
/**
 * Modal window on https://<server>/login in the SAME partition as the portal SSO window (persist:portal),
 * so the cookies the server sets there are what we adopt into the API client (copied into its jar).
 * The user types ID/password/OTP into the server's own page — we never see or store them.
 */
let webLoginWin: BrowserWindow | null = null;
let webLoginPending: Promise<any> | null = null;

/** Try the cookies currently in the partition: GET /api/user/session 200 → bootstrap. null if not logged in. */
async function tryAdoptPartitionSession(serverUrl: string) {
  const cookies = await portalSession().cookies.get({ url: serverUrl + "/" });
  if (!cookies.length) return null;
  const c = new MessengerCore(serverUrl);
  try {
    // probe with a throwaway client first so a failed probe does not tear down anything
    await c.client.adoptWebSession(serverUrl, cookies);
  } catch {
    return null;
  }
  // Don't call /api/logout here: the old jar may share the new server session; just stop the old core.
  core.shutdown();
  core = new MessengerCore(serverUrl);
  wireCore();
  return core.loginWithWebSession(serverUrl, cookies);
}

function finishWebLogin(serverUrl: string, user: { loginId: string }) {
  const key = accountKey(serverUrl, user.loginId);
  settings = { ...settings, serverUrl, username: user.loginId || settings.username, webLoginAccounts: markWebAccount(settings.webLoginAccounts, key) };
  saveSettings(settings);
  flexAutoLoginTried = false;
  flexPendingCache = { count: null, at: 0 };
}

function openWebLogin(serverUrl: string): Promise<any> {
  if (webLoginPending) {
    webLoginWin?.focus();
    return webLoginPending;
  }
  webLoginPending = new Promise((resolve, reject) => {
    let done = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let checking = false;
    const w = new BrowserWindow({
      width: 980, height: 760, title: `웹 로그인 — ${APP_NAME}`, parent: win ?? undefined, modal: !!win,
      autoHideMenuBar: true,
      webPreferences: { partition: PORTAL_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
    });
    webLoginWin = w;
    const finish = (err: Error | null, user?: any) => {
      if (done) return;
      done = true;
      if (poll) clearInterval(poll);
      if (!w.isDestroyed()) w.close();
      if (err) reject(err);
      else resolve(user ?? null);
    };
    const check = async () => {
      if (done || checking) return;
      checking = true;
      try {
        const u = await tryAdoptPartitionSession(serverUrl);
        if (u) {
          finishWebLogin(serverUrl, u);
          console.log("[auth] web login completed");
          finish(null, u);
        }
      } catch (e) {
        console.log("[auth] web login bootstrap failed:", (e as Error).name);
      } finally {
        checking = false;
      }
    };
    const allowed = (u: string) => isWebLoginNavAllowed(u, serverUrl);
    w.webContents.setWindowOpenHandler(({ url: u }) => {
      if (allowed(u)) void w.loadURL(u);
      return { action: "deny" };
    });
    const guard = (e: Electron.Event, u: string) => {
      if (!allowed(u)) {
        e.preventDefault();
        console.log("[auth] web login blocked navigation to", (() => { try { return new URL(u).host; } catch { return "?"; } })());
      }
    };
    w.webContents.on("will-navigate", guard);
    w.webContents.on("will-redirect", guard);
    w.webContents.on("will-attach-webview", (e) => e.preventDefault());
    const onNav = (_e: unknown, u: string) => { if (isWebLoginSuccessUrl(u, serverUrl)) void check(); };
    w.webContents.on("did-navigate", onNav);
    w.webContents.on("did-navigate-in-page", onNav);
    // SPA logins may not navigate: also poll the session (GET only, harmless for lockout).
    poll = setInterval(() => void check(), 3000);
    w.on("closed", () => {
      webLoginWin = null;
      finish(null, null); // user closed the window → cancelled
    });
    void w.loadURL(webLoginUrl(serverUrl)).catch(() => undefined);
  }).finally(() => { webLoginPending = null; });
  return webLoginPending;
}

async function openPortalWindow(url: string) {
  await syncPortalCookies();
  if (portalWin && !portalWin.isDestroyed()) {
    await portalWin.loadURL(url);
    if (portalWin.isMinimized()) portalWin.restore();
    portalWin.show();
    portalWin.focus();
    return;
  }
  portalWin = new BrowserWindow({
    width: 1280, height: 860, title: profile.id === "ubion" ? "DaouOffice — UBION Messenger" : APP_NAME, autoHideMenuBar: false,
    webPreferences: { partition: PORTAL_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  portalWin.setMenu(portalNavMenu());
  if (profile.flex) attachFlexWindowHooks(portalWin.webContents);
  const base = core.client.baseUrl;
  const inWin = (u: string) => isPortalUrl(u, base) || (profile.flex && (isFlexUrl(u) || isFlexSsoUrl(u)));
  portalWin.webContents.setWindowOpenHandler(({ url: u }) => {
    if (inWin(u)) {
      void portalWin?.loadURL(u);
    } else if (/^https?:/.test(u)) void shell.openExternal(u);
    return { action: "deny" };
  });
  portalWin.webContents.on("will-navigate", (e, u) => {
    if (!inWin(u)) {
      e.preventDefault();
      if (/^https?:/.test(u)) void shell.openExternal(u);
    }
  });
  portalWin.webContents.on("will-redirect", (e, u) => {
    if (!inWin(u)) {
      e.preventDefault();
      if (/^https?:/.test(u)) void shell.openExternal(u);
    }
  });
  portalWin.on("closed", () => (portalWin = null));
  await portalWin.loadURL(url);
}

// ---------- 문서 미리보기 viewer window ----------
/** Feature flag: server doc viewer only when UBM_DOC_VIEWER_URL is set (the official viewer URL is still unknown). */
const DOC_VIEWER_SERVER = docViewerServerEnabled(process.env);
let docViewerWin: BrowserWindow | null = null;
const previewTempDir = () => path.join(app.getPath("temp"), "ubion-preview");

/**
 * server=true: the configured doc-viewer URL in the portal partition (SSO cookies synced first), same-host only.
 * server=false: a downloaded temp file (pdf/images/txt) in a cookie-less in-memory session; no navigation.
 * plugins:true enables Chromium's built-in PDF viewer.
 */
async function openDocViewer(o: { url?: string; file?: string; title: string; server: boolean }) {
  if (o.server) await syncPortalCookies();
  if (docViewerWin && !docViewerWin.isDestroyed()) docViewerWin.close();
  const base = core.client.baseUrl;
  const w = new BrowserWindow({
    width: 1000, height: 860, title: `${o.title} — 미리보기`, autoHideMenuBar: true,
    webPreferences: {
      partition: o.server ? PORTAL_PARTITION : "doc-preview", plugins: true,
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  });
  docViewerWin = w;
  w.on("page-title-updated", (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/.test(u)) void shell.openExternal(u);
    return { action: "deny" };
  });
  const block = (e: Electron.Event, u: string) => {
    if (o.server && isPortalUrl(u, base)) return;
    e.preventDefault();
    if (/^https?:/.test(u)) void shell.openExternal(u);
  };
  w.webContents.on("will-navigate", block);
  w.webContents.on("will-redirect", block);
  w.on("closed", () => { if (docViewerWin === w) docViewerWin = null; });
  if (o.server && o.url) await w.loadURL(o.url);
  else if (o.file) await w.loadFile(o.file);
}

function clearPreviewTemp() {
  try { fs.rmSync(previewTempDir(), { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------- Zoom 연동 (UNVERIFIED OAuth, behind UBM_ZOOM=1) ----------
/** Secret: memory only, never logged, never sent to the renderer. Cleared on logout / core rewire. */
let zoomAccessToken: string | null = null;
let zoomConfigCache: { config: ZoomConfig | undefined } | null = null;
let zoomWin: BrowserWindow | null = null;
const zoomTokenWaiters = new Set<() => void>();

function setZoomToken(token: string | null) {
  zoomAccessToken = token || null;
  if (zoomAccessToken) for (const w of [...zoomTokenWaiters]) w();
}

function resetZoom() {
  zoomAccessToken = null;
  zoomConfigCache = null;
  if (zoomWin && !zoomWin.isDestroyed()) zoomWin.close();
}

async function loadZoomConfig(): Promise<ZoomConfig | undefined> {
  if (zoomConfigCache) return zoomConfigCache.config;
  try {
    const config = await core.client.fetchZoomConfig();
    zoomConfigCache = { config };
    return config;
  } catch (e) {
    console.warn("zoom config failed:", maskSecrets(String((e as Error)?.message ?? e)));
    return undefined;
  }
}

/**
 * Opens the Zoom authorize page in-app (portal partition so the Daou redirect sees the SSO cookie, like the
 * original window.open). Best effort: a token in the redirect URL is taken directly; otherwise the server is
 * expected to exchange the code and push the token over XMPP ("zoom" stanza). Resolves true once a token is held.
 */
function connectZoomWindow(authorizeUrl: string, redirectUri: string): Promise<boolean> {
  if (zoomWin && !zoomWin.isDestroyed()) zoomWin.close();
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 520, height: 720, title: "Zoom 연결", autoHideMenuBar: true,
      webPreferences: { partition: PORTAL_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
    });
    zoomWin = w;
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      zoomTokenWaiters.delete(onToken);
      if (!w.isDestroyed()) w.close();
      resolve(ok);
    };
    const onToken = () => finish(true);
    zoomTokenWaiters.add(onToken);
    timer = setTimeout(() => finish(!!zoomAccessToken), 10 * 60_000);
    const watch = (u: string) => {
      const r = extractZoomRedirect(u, redirectUri);
      if (!r) return;
      if (r.accessToken) return setZoomToken(r.accessToken);
      if (r.error) return finish(false);
      // Code only: the server exchanges it; give the XMPP push a short window.
      clearTimeout(timer);
      timer = setTimeout(() => finish(!!zoomAccessToken), 30_000);
    };
    const guard = (e: Electron.Event, u: string) => {
      if (/^https:/i.test(u) || extractZoomRedirect(u, redirectUri)) return watch(u);
      e.preventDefault();
    };
    w.on("page-title-updated", (e) => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.webContents.on("will-navigate", guard);
    w.webContents.on("will-redirect", guard);
    w.webContents.on("did-navigate", (_e, u) => watch(u));
    w.on("closed", () => {
      if (zoomWin === w) zoomWin = null;
      finish(!!zoomAccessToken);
    });
    // Never log the URL (it carries state / code).
    w.loadURL(authorizeUrl).catch((e) => console.warn("zoom authorize load failed:", maskSecrets(String((e as Error)?.name ?? e))));
  });
}

function notifyNewPost(p: MessengerEventMap["portalNewPost"]) {
  if (dndActive() || !settings.notifications || !settings.portalPostNotify || !Notification.isSupported()) return;
  const n = new Notification({
    title: `전사게시판${p.boardName ? ` · ${p.boardName}` : ""}: 새 글`,
    body: settings.notificationPreview ? p.summary.slice(0, 140) : "새 글이 등록되었습니다",
    silent: !settings.notificationSound,
  });
  n.on("click", () => void openPortal(p.url).catch(() => undefined));
  n.show();
}

function notifyNewPostSummary(p: MessengerEventMap["portalNewPostSummary"]) {
  if (dndActive() || !settings.notifications || !settings.portalPostNotify || !Notification.isSupported()) return;
  const n = new Notification({
    title: "전사게시판",
    body: `${p.count}${p.atLeast ? "개 이상의" : "개"} 새 글이 있습니다`,
    silent: !settings.notificationSound,
  });
  n.on("click", () => void openPortal("/app/board").catch(() => undefined));
  n.show();
}

// ---------- notifications ----------
function maybeNotify(m: MessengerEventMap["message"]) {
  if (!settings.notifications) return;
  if (
    isBotAuthDm({
      text: m.message,
      roomKind: m.roomKind,
      senderSeq: m.sendUserSeq,
      botUserSeq: ubmAuth.botUserSeq(),
    })
  ) return; // UBION login DM (bot challenge) — never notify
  if (dndActive()) return;
  const room = core.getRooms().find((r) => r.key === m.roomKey);
  const mentioned = !!room && room.kind === "room" && !room.isSelf &&
    isMentioningMe(m.message || "", core.user?.name || "");
  // Prefer the live room state: it changes immediately after the user toggles notifications.
  const usePush = m.usePush && (room?.usePush ?? true);
  if (!shouldNotify({ usePush, mentioned, isMine: m.isMine })) return;
  const viewing = win?.isFocused() && core.activeRoomKey === m.roomKey;
  if (viewing || !Notification.isSupported()) return;
  const base = room && room.kind !== "buddy" ? `${room.name} · ${m.sendUserName}` : m.sendUserName || APP_NAME;
  const title = mentioned ? `[멘션] ${base}` : base;
  const body = locked
    ? "새 메시지"
    : settings.notificationPreview
      ? m.attach
        ? `📎 ${m.attach.name}`
        : m.message.slice(0, 140)
      : "새 메시지가 도착했습니다";
  const n = new Notification({ title, body, silent: !settings.notificationSound });
  n.on("click", () => {
    showWindow();
    send("nav:openRoom", m.roomKey);
  });
  n.show();
  if (process.platform === "darwin" && !win?.isFocused()) app.dock?.bounce("informational");
  else if (!win?.isFocused()) win?.flashFrame(true);
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    title: APP_NAME,
    show: false,
    icon: resPath("icon.png"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#16181d" : "#ffffff",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      spellcheck: false,
      webviewTag: true,
    },
  });
  win.once("ready-to-show", () => {
    if (!startHidden) win?.show();
    startHidden = false;
  });
  win.on("focus", () => {
    core.onFocus();
    win?.flashFrame(false);
    send("window:focus", true);
  });
  win.on("blur", () => {
    core.focused = false;
    send("window:focus", false);
  });
  win.on("close", (e) => {
    if (!quitting && settings.closeToTray) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => (win = null));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("http://localhost") && !url.startsWith("file:")) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

// ---------- 화면 캡쳐 ----------
let captureBusy = false;

/** Grab the display under the cursor, let the user drag a region on a frozen overlay, return PNG bytes (null = cancelled). */
async function captureScreenRegion(): Promise<CaptureResult | null> {
  const status = process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("screen") : undefined;
  const denied = capturePermissionError(process.platform, status);
  if (denied) throw new Error(denied);
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: captureThumbnailSize(display.size, display.scaleFactor),
  });
  const source = pickScreenSource(sources, display.id);
  const image = source?.thumbnail;
  if (!image || image.isEmpty()) {
    throw new Error(process.platform === "darwin" ? capturePermissionError("darwin")! : "화면을 캡쳐하지 못했습니다");
  }
  const imgSize = image.getSize();
  const scale = captureScale(imgSize, display.bounds, display.scaleFactor);
  const { x, y, width, height } = display.bounds;
  const overlay = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/capture.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  overlay.webContents.on("will-navigate", (e) => e.preventDefault());
  const rect = await new Promise<unknown>((resolve) => {
    const onDone = (e: Electron.IpcMainEvent, r: unknown) => {
      if (e.sender !== overlay.webContents) return;
      resolve(r);
      if (!overlay.isDestroyed()) overlay.close();
    };
    ipcMain.on(CAPTURE_OVERLAY_DONE, onDone);
    overlay.on("closed", () => {
      ipcMain.removeListener(CAPTURE_OVERLAY_DONE, onDone);
      resolve(null);
    });
    overlay.webContents.once("did-finish-load", () => {
      // JPEG is only the frozen backdrop; the crop below comes from the full-quality capture.
      overlay.webContents.send(CAPTURE_OVERLAY_IMAGE, "data:image/jpeg;base64," + image.toJPEG(90).toString("base64"));
      overlay.setBounds(display.bounds);
      overlay.show();
      overlay.focus();
    });
    overlay.loadURL(captureOverlayUrl()).catch((e) => {
      console.warn("capture overlay failed:", maskSecrets(String((e as Error)?.message ?? e)));
      if (!overlay.isDestroyed()) overlay.close();
    });
  });
  const crop = normalizeCropRect(rect, imgSize, scale);
  if (!crop) return null;
  const png = image.crop(crop).toPNG();
  return { name: captureFileName(), type: "image/png", data: new Uint8Array(png), width: crop.width, height: crop.height };
}

function applyLoginItem() {
  if (process.platform === "linux") return;
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, openAsHidden: true, args: ["--hidden"] });
}

// ---------- IPC ----------
function registerIpc() {
  handle("app:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    flavor: profile.id,
    productName: profile.productName,
    productNameKo: profile.productNameKo,
    flex: profile.flex,
    unofficialNotice: profile.unofficialNotice,
    encryption: (() => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    })(),
  }));
  handle("i18n:caps", () => i18nCaps(process.env));
  handle("settings:get", () => ({ ...settings, hasSavedPassword: !!(settings.rememberMe && loadPassword()) }));
  handle("settings:set", (input: Partial<Settings>) => {
    // Custom theme list/selection only change through theme:* (validated ids, files on disk).
    const { customThemes: _ct, activeThemeId: _at, ...patch } = input || {};
    if ("themePreset" in patch) patch.themePreset = normalizePreset(patch.themePreset);
    if ("dndDays" in patch) patch.dndDays = normalizeDndDays(patch.dndDays);
    if ("dndStartMin" in patch) patch.dndStartMin = normalizeDndMin(patch.dndStartMin);
    if ("dndEndMin" in patch) patch.dndEndMin = normalizeDndMin(patch.dndEndMin);
    filterLanguagePatch(patch, process.env);
    if (!profile.flex && "flexAutoLogin" in patch) delete patch.flexAutoLogin;
    settings = { ...settings, ...patch };
    saveSettings(settings);
    if ("launchAtLogin" in patch) applyLoginItem();
    if ("theme" in patch) nativeTheme.themeSource = settings.theme;
    if ("autoUpdate" in patch) updater.schedule(settings.autoUpdate);
    if ("awayMinutes" in patch || "mobileNotice" in patch) startAwayMonitor();
    if ("lockTimeoutMin" in patch) maybeAutoLock();
    if ("language" in patch) applyLanguage();
    if (patch.rememberMe === false) {
      clearPassword();
      settings.autoLogin = false;
      saveSettings(settings);
    }
    return settings;
  });

  handle("auth:state", () => ({ user: core.user, conn: core.conn }));
  handle("auth:botUserSeq", () => ubmAuth.botUserSeq());
  handle(
    "auth:login",
    async (o: { serverUrl: string; username: string; password?: string; rememberMe: boolean; autoLogin: boolean }) => {
      // Saved password belongs to settings.username only; never reuse it for a different account.
      const sameUser = o.username.trim() === (settings.username || "").trim();
      const password = o.password || (o.rememberMe && sameUser ? loadPassword() : null);
      const serverUrl = normalizeServerUrl(o.serverUrl ?? settings.serverUrl);
      const key = accountKey(serverUrl, o.username);
      const flagged = !!settings.webLoginAccounts?.includes(key);
      // OTP accounts: never re-POST /api/login with the saved password (lockout risk) — reuse web cookies or ask for web login.
      if (planLogin({ flagged, typedPassword: !!o.password }) === "web-silent") {
        const u = await tryAdoptPartitionSession(serverUrl).catch(() => null);
        if (u) {
          finishWebLogin(serverUrl, u);
          return u;
        }
        return { webLoginRequired: true, message: WEB_LOGIN_MESSAGE };
      }
      if (!password) throw new Error("비밀번호를 입력하세요");
      if (core.user) {
        await core.logout();
        await ubmAuth.logout();
      }
      core = new MessengerCore(serverUrl);
      wireCore();
      let user;
      try {
        user = await core.login({ serverUrl, username: o.username.trim(), password });
      } catch (e) {
        // Safe diagnostic: status + server code/message/redirect only (no id/password/cookies).
        if (e instanceof HttpError && e.diag) console.log("[auth] login failed:", e.diag);
        if (e instanceof HttpError && e.webLogin) {
          // Password was accepted (200) but a further step is needed: remember account, keep saved password.
          settings = { ...settings, serverUrl, username: o.username.trim(), rememberMe: o.rememberMe, autoLogin: o.rememberMe && o.autoLogin, webLoginAccounts: markWebAccount(settings.webLoginAccounts, key) };
          saveSettings(settings);
          if (o.rememberMe && o.password) savePassword(password);
          return { webLoginRequired: true, message: e.message };
        }
        throw e;
      }
      if (flagged) settings = { ...settings, webLoginAccounts: unmarkWebAccount(settings.webLoginAccounts, key) };
      settings = { ...settings, serverUrl, username: o.username.trim(), rememberMe: o.rememberMe, autoLogin: o.rememberMe && o.autoLogin };
      saveSettings(settings);
      if (o.rememberMe) savePassword(password);
      else clearPassword();
      flexAutoLoginTried = false;
      flexPendingCache = { count: null, at: 0 };
      return user;
    }
  );
  handle("auth:webLogin", async (o?: { serverUrl?: string }) => {
    const serverUrl = normalizeServerUrl(o?.serverUrl ?? settings.serverUrl);
    return openWebLogin(serverUrl); // SessionUser, or null if the user closed the window
  });
  handle("auth:logout", async () => {
    searchCache?.flush();
    await core.logout("user");
    await ubmAuth.logout();
    mediaCache.clear();
    await clearPortalSession();
    flexAutoLoginTried = false;
    flexPendingCache = { count: null, at: 0 };
    settings = { ...settings, autoLogin: false };
    saveSettings(settings);
    updateBadge();
  });

  handle("lock:status", () => ({ enabled: !!lockRecord, locked, timeoutMin: settings.lockTimeoutMin }));
  handle("lock:setPin", (newPin: unknown, currentPin?: unknown) => {
    if (!validatePin(newPin)) throw new Error("PIN은 4~12자리 숫자로 설정하세요.");
    if (lockRecord) {
      if (!validatePin(currentPin)) throw new Error("현재 PIN을 입력하세요.");
      if (!verifyPin(currentPin, lockRecord)) throw new Error("현재 PIN이 올바르지 않습니다.");
    }
    if (!lockStorageAvailable()) throw new Error(LOCK_STORAGE_UNAVAILABLE);
    const rec = hashPin(newPin);
    if (!saveLockRecord(rec)) throw new Error(LOCK_STORAGE_UNAVAILABLE);
    lockRecord = rec;
    lockState.reset();
    return { ok: true, enabled: true };
  });
  handle("lock:disable", (currentPin: unknown) => {
    if (!lockRecord) return { ok: true, enabled: false };
    if (!validatePin(currentPin) || !verifyPin(currentPin, lockRecord)) {
      throw new Error("PIN이 올바르지 않습니다.");
    }
    clearLockRecord();
    lockRecord = null;
    lockState.reset();
    setLocked(false);
    return { ok: true, enabled: false };
  });
  handle("lock:lockNow", () => {
    if (!lockRecord) throw new Error("설정에서 PIN을 먼저 설정하세요.");
    return { ok: lockNow(), locked };
  });
  handle("lock:unlock", (pin: unknown) => {
    if (!locked || !lockRecord) {
      setLocked(false);
      return { ok: true };
    }
    if (!validatePin(pin)) return { ok: false, error: "PIN은 4~12자리 숫자입니다." };
    const result = lockState.attempt(pin, lockRecord);
    if (result.ok) {
      setLocked(false);
      return { ok: true };
    }
    return result.cooldownMs
      ? { ok: false, error: "PIN이 올바르지 않습니다.", cooldownMs: result.cooldownMs }
      : { ok: false, error: "PIN이 올바르지 않습니다." };
  });

  handle("rooms:list", () => core.getRooms());
  handle("rooms:refresh", () => core.refreshRooms());
  handle("rooms:setActive", (key: string | null) => core.setActiveRoom(key));
  handle("rooms:pin", (key: string, pin: boolean) => core.setPin(key, pin));
  handle("rooms:setPush", (key: string, usePush: boolean) => core.setRoomPush(key, !!usePush));
  handle("bot:roomSettings:get", (roomKey: unknown) => {
    if (!profile.enhancedServer) throw new Error("이 빌드에서는 봇 설정을 사용하지 않습니다");
    if (typeof roomKey !== "string" || !/^room:\d+$/.test(roomKey)) throw new Error("잘못된 대화방입니다");
    return botSettingsWithRetry.get(roomKey);
  });
  handle("bot:roomSettings:set", (roomKey: unknown, autonomy: unknown) => {
    if (!profile.enhancedServer) throw new Error("이 빌드에서는 봇 설정을 사용하지 않습니다");
    if (typeof roomKey !== "string" || !/^room:\d+$/.test(roomKey)) throw new Error("잘못된 대화방입니다");
    if (typeof autonomy !== "boolean") throw new Error("자율활동 설정 값이 올바르지 않습니다");
    return botSettingsWithRetry.set(roomKey, autonomy);
  });
  handle("rooms:openDirect", (userId: number) => core.openDirect(userId));
  handle("rooms:createGroup", (ids: number[]) => core.createGroup(ids));
  handle("msg:history", async (key: string, before?: number) => {
    const list = await core.history(key, before);
    core.noteSeen(key, list);
    indexMessages(key, list);
    return list;
  });
  handle("rooms:sync", () => core.sync("manual"));
  handle("rooms:members", (key: string) => core.members(key));
  handle("msg:search", async (key: string, kw: string) => {
    const list = await core.searchInRoom(key, kw);
    indexMessages(key, list);
    return list;
  });
  // 통합 검색: local cache first, then a throttled read-only fan-out over per-room search (recent rooms first).
  // Progress streams on "search:progress"; a new search or search:cancel aborts the previous one.
  const searchLimiter = createRateLimiter({ concurrency: DEFAULT_CONCURRENCY, minIntervalMs: DEFAULT_MIN_INTERVAL_MS });
  let searchAbort: AbortController | null = null;
  handle("search:caps", () => globalSearchCaps(process.env));
  handle("search:global", async (searchId: unknown, raw: unknown) => {
    const id = Number(searchId);
    if (!Number.isSafeInteger(id)) throw new Error("잘못된 검색 요청입니다");
    const q = normalizeGlobalQuery(raw);
    const me = core.user?.id;
    if (me == null) throw new Error("로그인이 필요합니다");
    searchAbort?.abort();
    const ac = (searchAbort = new AbortController());
    const caps = globalSearchCaps(process.env);
    try {
      return await runGlobalSearch(q, {
        searchId: id,
        rooms: core.getRooms(),
        userSeq: me,
        getJson: (p) => core.client.searchGet(p),
        index: searchIndex() ?? undefined,
        limiter: searchLimiter,
        maxRooms: caps.maxRooms,
        serverEnabled: caps.server,
        dateRangeEnabled: caps.dateRange,
        signal: ac.signal,
        onProgress: (p) => send("search:progress", p),
        onRoomError: (room, e) => console.warn(`global search ${room.kind} room failed:`, maskSecrets(String((e as Error)?.message ?? e))),
      });
    } finally {
      if (searchAbort === ac) searchAbort = null;
      searchCache?.scheduleSave();
    }
  });
  handle("search:cancel", () => {
    searchAbort?.abort();
    searchAbort = null;
  });
  handle("search:cacheInfo", () => ({ docs: searchIndex()?.size ?? 0 }));
  handle("search:clearCache", () => {
    searchAbort?.abort();
    if (!searchCache) searchCache = new SearchCacheStore(path.join(app.getPath("userData"), "search-cache"), fs, { join: path.join });
    searchCache.clear();
    return { docs: 0 };
  });
  handle("msg:send", (key: string, text: string) => {
    // 안전 모드(UBM_SELF_ONLY)에서는 일반 전송도 나에게만. 인용 답장(quote reply)은 렌더러에서
    // 본문을 조합해 이 msg:send 경로로 전송하므로, 이 가드가 그 경로까지 커버한다 (files:sendBuffer와 동일).
    if (process.env.UBM_SELF_ONLY === "1") guardedRoomSeq(key);
    return core.sendText(key, text);
  });
  handle("msg:delete", (ids: unknown) => core.client.deleteChatMessages(ids));
  handle("msg:forwardRoom", (roomSeq: number, cryptIds: string[]) => {
    const me = core.user?.id;
    if (me == null) throw new Error("로그인이 필요합니다");
    checkForwardTarget({ selfOnly: process.env.UBM_SELF_ONLY === "1", target: { roomSeq }, me, selfRoomSeq: selfRoomApiSeq() });
    return core.client.forwardToRoom(roomSeq, cryptIds);
  });
  handle("msg:forwardMembers", (memberSeqs: number[], cryptIds: string[], roomType: "single" | "group") => {
    const me = core.user?.id;
    if (me == null) throw new Error("로그인이 필요합니다");
    checkForwardTarget({ selfOnly: process.env.UBM_SELF_ONLY === "1", target: { memberSeqs }, me, selfRoomSeq: selfRoomApiSeq() });
    return core.client.forwardToMembers(memberSeqs, cryptIds, roomType);
  });
  handle("room:notice", async (key: string, messageId: number) => {
    const me = core.user?.id;
    if (me == null) throw new Error("로그인이 필요합니다");
    const room = core.getRooms().find((r) => r.key === key);
    if (!room) throw new Error("알 수 없는 대화방입니다");
    const roomSeq = apiRoomSeq(room);
    checkForwardTarget({ selfOnly: process.env.UBM_SELF_ONLY === "1", target: { roomSeq }, me, selfRoomSeq: selfRoomApiSeq() });
    await core.client.registerRoomNotice(roomSeq, messageId);
    await core.refreshRooms();
    return core.getRooms().find((r) => r.key === key) || room;
  });
  handle("msg:markRead", (key: string, mid?: number) => core.markRead(key, mid));
  // 대화 백업 / 대화 기록 삭제. Mutations go through the same self-only guard as forward/notice.
  const HISTORY_CLEAR_ENABLED = historyClearEnabled(process.env);
  const guardedRoomSeq = (key: unknown): number => {
    const me = core.user?.id;
    if (me == null) throw new Error("로그인이 필요합니다");
    const room = core.getRooms().find((r) => r.key === key);
    if (!room) throw new Error("알 수 없는 대화방입니다");
    const roomSeq = apiRoomSeq(room);
    checkForwardTarget({ selfOnly: process.env.UBM_SELF_ONLY === "1", target: { roomSeq }, me, selfRoomSeq: selfRoomApiSeq() });
    return roomSeq;
  };
  const roomSeqOf = (key: unknown): number => {
    const room = core.getRooms().find((r) => r.key === key);
    if (!room) throw new Error("알 수 없는 대화방입니다");
    return apiRoomSeq(room);
  };
  const logged = <T>(what: string, p: Promise<T>): Promise<T> =>
    p.catch((e) => {
      console.warn(`${what} failed:`, maskSecrets(String((e as Error)?.message ?? e)));
      throw e;
    });
  handle("backup:config", () => ({ historyClearEnabled: HISTORY_CLEAR_ENABLED }));
  handle("backup:request", (key: string, from: string, to: string, fileType?: string) =>
    logged("backup request", core.client.requestBackup(guardedRoomSeq(key), from, to, normalizeBackupFileType(fileType)))
  );
  handle("backup:list", () => logged("backup list", core.client.listBackups()));
  handle("backup:delete", (key: string, backupId: number) =>
    logged("backup delete", core.client.deleteBackup(guardedRoomSeq(key), backupId))
  );
  handle("backup:download", async (key: string, backupId: number, mode: SaveMode = "downloads") => {
    if (!["downloads", "saveAs", "open"].includes(mode)) throw new Error("invalid save mode");
    const roomSeq = roomSeqOf(key);
    const item = (await core.client.listBackups()).find((b) => b.id === Number(backupId) && b.roomSeq === roomSeq);
    if (!item) throw new Error("백업 파일을 찾을 수 없습니다");
    const r = await resolveSaveTarget(
      { mode, name: backupFileName(item), downloadDir: settings.downloadDir, askEveryTime: !!settings.askSaveLocation, lastSaveDir: settings.lastSaveDir, defaultDownloads: app.getPath("downloads") },
      {
        exists: (p) => fs.existsSync(p),
        showSaveDialog: async (defaultPath) => {
          const d = await dialog.showSaveDialog(win!, { defaultPath });
          return d.canceled || !d.filePath ? null : d.filePath;
        },
      },
    );
    if (!r) return null;
    const { data } = await logged("backup download", core.client.downloadBackup(roomSeq, item.id));
    fs.mkdirSync(path.dirname(r.target), { recursive: true });
    fs.writeFileSync(r.target, data);
    savedPaths.add(r.target);
    if (r.dir !== settings.lastSaveDir) { settings = { ...settings, lastSaveDir: r.dir }; saveSettings(settings); }
    if (mode === "open") await shell.openPath(r.target);
    return r.target;
  });
  // 공지톡. List/detail are read-only; send/delete need UBM_PUBSUB_SEND=1 and pass the self-only guard.
  const PUBSUB_SEND_ENABLED = pubsubSendEnabled(process.env);
  handle("pubsub:caps", () => pubsubCaps(process.env));
  handle("pubsub:list", (page?: number) => logged("pubsub list", core.client.listPubsubs(Number(page) || 0)));
  handle("pubsub:detail", (id: number) => logged("pubsub detail", core.client.getPubsub(id)));
  handle("pubsub:send", (input: { message?: unknown; targets?: unknown; range?: string } = {}) => {
    const me = core.user?.id;
    if (me == null) throw new Error("로그인이 필요합니다");
    const targets = checkPubsubSend({
      enabled: PUBSUB_SEND_ENABLED, selfOnly: process.env.UBM_SELF_ONLY === "1", range: input?.range, targets: input?.targets, me,
    });
    return logged("pubsub send", core.client.sendPubsub(String(input?.message ?? ""), targets, input?.range));
  });
  handle("pubsub:delete", async (id: number) => {
    const me = core.user?.id;
    if (me == null) throw new Error("로그인이 필요합니다");
    const selfOnly = process.env.UBM_SELF_ONLY === "1";
    if (!PUBSUB_SEND_ENABLED) throw new Error(PUBSUB_SEND_DISABLED_TEXT);
    const detail = selfOnly ? await logged("pubsub detail", core.client.getPubsub(id)) : null;
    checkPubsubDelete({ enabled: PUBSUB_SEND_ENABLED, selfOnly, detail, me });
    return logged("pubsub delete", core.client.deletePubsub(id));
  });
  // Zoom 연동. createMeeting only creates the Zoom meeting; the join URL goes to the composer and the user sends it.
  const ZOOM_ON = zoomEnabled(process.env);
  handle("zoom:caps", async () => {
    const config = ZOOM_ON && core.user ? await loadZoomConfig() : undefined;
    return zoomCaps({ env: process.env, config, connected: !!zoomAccessToken });
  });
  handle("zoom:connect", async (key: string) => {
    if (!ZOOM_ON) throw new Error(ZOOM_DISABLED_TEXT);
    const roomSeq = guardedRoomSeq(key);
    const config = await loadZoomConfig();
    if (!config?.use) throw new Error("서버에 Zoom 연동이 설정되어 있지 않습니다");
    const { clientId } = resolveZoomClientId(config, process.env.UBM_ZOOM_CLIENT_ID);
    const redirectUri = zoomRedirectUri(core.client.baseUrl);
    const state = zoomState({ resource: core.client.resource, userSeq: core.user!.id, roomSeq });
    await syncPortalCookies().catch((e) => console.warn("portal cookie sync failed:", (e as Error).name));
    return { connected: await connectZoomWindow(zoomAuthorizeUrl(clientId, redirectUri, state), redirectUri) };
  });
  handle("zoom:createMeeting", async (key: string) => {
    if (!ZOOM_ON) throw new Error(ZOOM_DISABLED_TEXT);
    guardedRoomSeq(key);
    if (!zoomAccessToken) return { needsConnect: true as const };
    const r = await logged("zoom meeting", core.client.createZoomMeeting(zoomAccessToken));
    if (r === "auth") {
      setZoomToken(null);
      return { needsConnect: true as const };
    }
    return { joinUrl: r.joinUrl };
  });
  handle("history:clear", async (key: string, messageId: number, confirmed: unknown) => {
    if (!HISTORY_CLEAR_ENABLED) throw new Error("대화 기록 삭제는 아직 지원되지 않습니다");
    if (confirmed !== true) throw new Error("대화 기록 삭제를 확인해 주세요");
    const roomSeq = guardedRoomSeq(key);
    await logged("history clear", core.client.clearHistoryBefore(roomSeq, messageId));
    return { ok: true as const };
  });
  handle("files:sendPaths", async (key: string, paths: string[]) => {
    if (process.env.UBM_SELF_ONLY === "1") guardedRoomSeq(key);
    for (const p of paths) {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      if (st.size > 300 * 1024 * 1024) throw new Error(`${path.basename(p)}: 300MB를 초과합니다`);
      await core.sendFile(key, { name: path.basename(p), data: fs.readFileSync(p), mime: guessMime(p) });
    }
  });
  handle("files:sendBuffer", (key: string, name: string, data: ArrayBuffer, mime?: string) => {
    // Pasted/captured images: in safe mode (UBM_SELF_ONLY) only the 나 room may receive them.
    if (process.env.UBM_SELF_ONLY === "1") guardedRoomSeq(key);
    return core.sendFile(key, { name, data: Buffer.from(data), mime });
  });
  handle(CAPTURE_START, async () => {
    if (captureBusy) throw new Error("이미 화면 캡쳐 중입니다");
    captureBusy = true;
    try {
      return await captureScreenRegion();
    } catch (e) {
      console.warn("screen capture failed:", maskSecrets(String((e as Error)?.message ?? e)));
      throw e;
    } finally {
      captureBusy = false;
    }
  });
  handle("files:pick", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openFile", "multiSelections"] });
    return r.canceled ? [] : r.filePaths;
  });
  /** Pick files for the renderer's staging tray (metadata + small image previews); sending still uses paths. */
  handle("files:pickForStaging", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openFile", "multiSelections"] });
    if (r.canceled) return { files: [], errors: [] };
    const files: Array<{ path: string; name: string; size: number; lastModified: number; type: string; preview?: Buffer }> = [];
    const errors: string[] = [];
    for (const p of r.filePaths) {
      const name = path.basename(p);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) {
          errors.push(`${name}: 폴더는 첨부할 수 없습니다`);
          continue;
        }
        const type = guessMime(p);
        const file = { path: p, name, size: st.size, lastModified: Math.round(st.mtimeMs), type };
        // Read only (small) images so the renderer can make an object URL thumbnail. Never for sending.
        if (type.startsWith("image/") && st.size <= 12 * 1024 * 1024) {
          try {
            files.push({ ...file, preview: fs.readFileSync(p) });
          } catch {
            files.push(file);
          }
        } else {
          files.push(file);
        }
      } catch (e) {
        errors.push(`${name}: ${(e as Error).message}`);
      }
    }
    return { files, errors };
  });
  handle("files:download", async (cryptId: string, messageId: number, name: string, open?: boolean) => {
    const { data } = await core.client.fetchBinary(core.client.fileUrlPath(cryptId, messageId));
    let target: string;
    if (open) {
      const dir = settings.downloadDir || app.getPath("downloads");
      target = uniquePath(path.join(dir, name));
    } else {
      const r = await dialog.showSaveDialog(win!, {
        defaultPath: path.join(settings.downloadDir || app.getPath("downloads"), name),
      });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    fs.writeFileSync(target, data);
    if (open) await shell.openPath(target);
    else shell.showItemInFolder(target);
    return target;
  });
  handle("files:save", async (cryptId: string, messageId: number, name: string, mode: SaveMode) => {
    if (!["downloads", "saveAs", "open"].includes(mode)) throw new Error("invalid save mode");
    const r = await resolveSaveTarget(
      { mode, name, downloadDir: settings.downloadDir, askEveryTime: !!settings.askSaveLocation, lastSaveDir: settings.lastSaveDir, defaultDownloads: app.getPath("downloads") },
      {
        exists: (p) => fs.existsSync(p),
        showSaveDialog: async (defaultPath) => {
          const d = await dialog.showSaveDialog(win!, { defaultPath });
          return d.canceled || !d.filePath ? null : d.filePath;
        },
      },
    );
    if (!r) return null;
    const { data } = await core.client.fetchBinary(core.client.fileUrlPath(cryptId, messageId));
    fs.mkdirSync(path.dirname(r.target), { recursive: true });
    fs.writeFileSync(r.target, data);
    savedPaths.add(r.target);
    if (r.dir !== settings.lastSaveDir) { settings = { ...settings, lastSaveDir: r.dir }; saveSettings(settings); }
    if (mode === "open") await shell.openPath(r.target);
    return r.target;
  });
  handle("file:preview", async (cryptId: string, messageId: number, name: string, ext?: string): Promise<{ mode: PreviewMode }> => {
    if (typeof cryptId !== "string" || !cryptId) throw new Error("미리보기할 파일 정보가 없습니다.");
    // "external" hands the temp file to the OS: never for executables/scripts, only the listed document types.
    if (!isPreviewExtension(name, ext)) throw new Error("미리보기를 지원하지 않는 파일 형식입니다.");
    const mid = Number.isFinite(Number(messageId)) ? Number(messageId) : undefined;
    const template = DOC_VIEWER_SERVER ? docViewerTemplate(process.env) : "";
    const mode = planPreview(name, ext, DOC_VIEWER_SERVER);
    try {
      if (mode === "server") {
        const url = buildPreviewUrl(core.client.baseUrl, cryptId, core.user?.id, template);
        if (!url) throw new Error("문서 뷰어 주소(UBM_DOC_VIEWER_URL)가 올바르지 않습니다.");
        await openDocViewer({ url, title: name, server: true });
        return { mode };
      }
      const p = core.client.fileUrlPath(cryptId, mid);
      const hit = mediaCache.get(p);
      const { data, contentType } = hit || (await core.client.fetchBinary(p));
      if (!hit) mediaCache.set(p, { data, contentType });
      const dir = previewTempDir();
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, previewTempName(name, mid, ext));
      fs.writeFileSync(target, data);
      if (mode === "inapp") await openDocViewer({ file: target, title: name, server: false });
      else {
        const err = await shell.openPath(target);
        if (err) throw new Error(err);
      }
      return { mode };
    } catch (e) {
      console.warn("file preview failed:", maskSecrets(String((e as Error)?.message ?? e)));
      throw e;
    }
  });
  handle("files:showInFolder", (p: string) => {
    if (typeof p === "string" && savedPaths.has(p)) shell.showItemInFolder(p);
  });
  handle("settings:pickDownloadDir", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"], defaultPath: settings.downloadDir || app.getPath("downloads") });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  // 테마 업로드: CSS text in userData/themes/<id>.css, metadata in settings.
  const themesDir = () => path.join(app.getPath("userData"), "themes");
  const themeState = (): ThemeState => ({ themes: settings.customThemes, activeThemeId: settings.activeThemeId });
  const saveThemeState = (st: ThemeState): ThemeState => {
    settings = { ...settings, customThemes: st.themes, activeThemeId: st.activeThemeId };
    saveSettings(settings);
    return st;
  };
  handle("theme:list", () => themeState());
  handle("theme:import", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openFile"], filters: [{ name: "CSS", extensions: ["css"] }] });
    const file = r.canceled ? undefined : r.filePaths[0];
    if (!file) return null;
    if (!isCssFileName(file)) throw new Error("CSS 파일(.css)만 가져올 수 있습니다");
    checkThemeSize((await fs.promises.stat(file)).size);
    const { css, removed } = sanitizeThemeCss(await fs.promises.readFile(file, "utf8"));
    if (!css) throw new Error("적용할 CSS 내용이 없습니다");
    checkThemeSize(Buffer.byteLength(css));
    const theme = { id: newThemeId(), name: themeNameFromPath(file) };
    await fs.promises.mkdir(themesDir(), { recursive: true });
    await fs.promises.writeFile(path.join(themesDir(), themeFileName(theme.id)), css, "utf8");
    if (removed.length) console.warn("theme import sanitized:", removed.join(", "));
    return { ...saveThemeState(addTheme(themeState(), theme)), id: theme.id, removed };
  });
  handle("theme:remove", async (id: string) => {
    const name = themeFileName(id);
    await fs.promises.rm(path.join(themesDir(), name), { force: true }).catch((e) =>
      console.warn("theme remove failed:", maskSecrets(String((e as Error)?.message ?? e))));
    return saveThemeState(removeTheme(themeState(), id));
  });
  handle("theme:activate", (id: string | null) => {
    if (id && !settings.customThemes.some((t) => t.id === id)) throw new Error("알 수 없는 테마입니다");
    return saveThemeState(activateTheme(settings.customThemes, id || ""));
  });
  handle("theme:css", async (id?: string) => {
    const target = id ?? settings.activeThemeId;
    if (!target) return "";
    if (!settings.customThemes.some((t) => t.id === target)) return "";
    const p = path.join(themesDir(), themeFileName(target));
    try {
      checkThemeSize((await fs.promises.stat(p)).size);
      // Re-sanitize on read: the file may have been edited outside the app.
      return sanitizeThemeCss(await fs.promises.readFile(p, "utf8")).css;
    } catch (e) {
      console.warn("theme css read failed:", maskSecrets(String((e as Error)?.message ?? e)));
      return "";
    }
  });
  handle("link:preview", (url: string) =>
    linkCache.get(url, () => fetchLinkPreview(url, { companyBase: core.client.baseUrl }))
  );
  handle("link:image", (url: string) =>
    ogImageCache.get(url, async () => {
      const d = await fetchPreviewImage(url, { companyBase: core.client.baseUrl });
      return d ? { url, image: d } : null;
    }).then((r) => r?.image ?? null)
  );
  handle("update:status", () => ({ ...updater.status, supported: updater.supported, platform: process.platform }));
  handle("update:check", () => updater.check());
  handle("update:download", () => updater.downloadMac());
  handle("update:install", () => updater.install());
  handle("update:openPage", () => updater.openReleasePage());
  handle("org:users", (force?: boolean) => core.users(force));
  handle("org:departments", () => core.departments());
  handle("org:presence", () => core.allPresence());
  handle("favorites:list", () => core.client.listFavorites());
  handle("favorites:add", (id: unknown) => core.client.addFavorite(id));
  handle("favorites:remove", (id: unknown) => core.client.removeFavorite(id));
  // 저장한 메시지 / 나중에 알림: client-local only (JSON in userData), no server calls.
  handle("saved:list", () => saved().for(core.user?.id).slice());
  handle("saved:add", (input: unknown) => {
    saved().for(core.user?.id);
    return saved().add(normalizeSavedInput(input));
  });
  handle("saved:remove", (id: unknown) => {
    if (typeof id !== "string" || !id) throw new Error("잘못된 요청입니다");
    saved().for(core.user?.id);
    saved().remove(id);
    return { ok: true as const };
  });
  handle("reminder:list", () => reminders().for(core.user?.id).slice());
  handle("reminder:add", (input: unknown) => {
    reminders().for(core.user?.id);
    const item = reminders().add(normalizeReminderInput(input, Date.now()));
    scheduleReminderTimer();
    return item;
  });
  handle("reminder:remove", (id: unknown) => {
    if (typeof id !== "string" || !id) throw new Error("잘못된 요청입니다");
    reminders().for(core.user?.id);
    reminders().remove(id);
    scheduleReminderTimer();
    return { ok: true as const };
  });
  // 예약 전송: client-local queue; the timer fires the normal send path (with the self-only guard).
  handle("schedule:list", () => scheduled().for(core.user?.id).slice());
  handle("schedule:add", (input: unknown) => {
    if (core.user == null) throw new Error("로그인이 필요합니다");
    scheduled().for(core.user.id);
    const item = scheduled().add(normalizeScheduledInput(input, Date.now()));
    armScheduledTimer(false);
    return item;
  });
  handle("schedule:cancel", (id: unknown) => {
    if (typeof id !== "string" || !id) throw new Error("잘못된 요청입니다");
    scheduled().for(core.user?.id);
    scheduled().remove(id);
    armScheduledTimer(false);
    return { ok: true as const };
  });
  handle("schedule:sendNow", async (id: unknown) => {
    if (typeof id !== "string" || !id) throw new Error("잘못된 요청입니다");
    const store = scheduled();
    store.for(core.user?.id);
    const item = store.list().find((s) => s.id === id);
    if (!item) throw new Error("예약 메시지를 찾을 수 없습니다");
    await sendScheduled(item);
    store.remove(id);
    return { ok: true as const };
  });
  // 방해 금지 시간: manual window is computed in main (server-agnostic).
  handle("dnd:manual", (hours: unknown) => {
    const manualUntil = computeManualUntil(Date.now(), hours);
    settings = { ...settings, dndManualUntil: manualUntil };
    saveSettings(settings);
    return { manualUntil };
  });
  // 상태 메시지 (XMPP free-text presence + server fallback), gated by UBM_STATUS_XMPP / UBM_STATUS_SERVER.
  handle("status:caps", () => {
    const caps = statusCaps(process.env);
    return profile.enhancedServer ? caps : { ...caps, server: false };
  });
  handle("status:get", async () => {
    const me = core.user?.id;
    if (me == null) return { text: null as string | null };
    if (profile.enhancedServer && statusServerEnabled(process.env) && !currentStatusText) {
      const r = await statusClient().get(me);
      if (r.ok && r.text) currentStatusText = r.text;
    }
    return { text: currentStatusText };
  });
  handle("status:set", async (text: unknown) => {
    const me = core.user?.id;
    if (me == null) throw new Error("로그인이 필요합니다");
    const value = normalizeStatusText(text);
    if (statusXmppEnabled(process.env)) core.setStatusMessage(value || "");
    if (profile.enhancedServer && statusServerEnabled(process.env)) {
      const r = await statusClient().put(me, value);
      if (!r.ok) throw new Error(r.message);
    }
    currentStatusText = value || null;
    return { text: currentStatusText };
  });
  handle("status:presenceStatus", () => core.allStatusMessages());
  // 이모지 리액션: our server (bot.ubion.global) keyed by roomSeq:messageId. On by default; UBM_REACTIONS=0 disables.
  const REACTIONS_ON = profile.enhancedServer && reactionsEnabled(process.env);
  handle("reactions:caps", () => ({ enabled: REACTIONS_ON }));
  // Diagnostics (no tokens/codes: only channel, room, status text): userData/ubm-reactions.log, capped ~256 KB.
  const reactionsLog = (line: string) => {
    try {
      const file = path.join(app.getPath("userData"), "ubm-reactions.log");
      try { if (fs.statSync(file).size > 256 * 1024) fs.renameSync(file, file + ".1"); } catch { /* new file */ }
      fs.appendFileSync(file, `${new Date().toISOString()} ${redactDiag(line)}\n`, { mode: 0o600 });
    } catch { /* best effort */ }
  };
  const handleR = (ch: string, fn: (...a: any[]) => Promise<unknown>) => handle(ch, async (...a: any[]) => {
    try { return await fn(...a); } catch (e) { reactionsLog(`${ch} error: ${errMsg(e)}`); throw e; }
  });
  handleR("reactions:list", async (roomSeq: unknown, ids: unknown) => {
    if (!REACTIONS_ON) throw new Error(REACTIONS_DISABLED_TEXT);
    if (core.user == null) { reactionsLog("list fail: no core.user"); throw new Error("로그인이 필요합니다"); }
    const seq = normalizeRoomSeq(roomSeq);
    const r = await reactionsClient().list(seq, normalizeMessageIds(ids));
    if (!r.ok) { reactionsLog(`list room=${seq} user=${core.user?.id ?? 0} fail: ${r.message}`); throw new Error(r.message); }
    return r.data;
  });
  handleR("reactions:toggle", async (roomSeq: unknown, messageId: unknown, emoji: unknown) => {
    if (!REACTIONS_ON) throw new Error(REACTIONS_DISABLED_TEXT);
    const me = core.user?.id;
    if (me == null) { reactionsLog("toggle fail: no core.user"); throw new Error("로그인이 필요합니다"); }
    const seq = normalizeRoomSeq(roomSeq);
    const mid = normalizeMessageId(messageId);
    const e = normalizeEmoji(emoji);
    guardReactionRoom({ selfOnly: process.env.UBM_SELF_ONLY === "1", roomSeq: seq, me, selfRoomSeq: selfRoomApiSeq() });
    reactionsLog(`toggle room=${seq} msg=${mid} send`);
    const r = await reactionsClient().toggle(seq, mid, e);
    if (!r.ok) { reactionsLog(`toggle room=${seq} msg=${mid} fail: ${r.message}`); throw new Error(r.message); }
    reactionsLog(`toggle room=${seq} msg=${mid} ok keys=${Object.keys(r.data).join(",")}`);
    return r.data;
  });
  // 투표: our server (bot.ubion.global / UBM_BOT_API_URL); bot posts the poll + results. Behind UBM_POLLS=1.
  const POLLS_ON = profile.enhancedServer && pollsEnabled(process.env);
  handle("polls:caps", () => {
    const caps = pollsCaps(process.env);
    return profile.enhancedServer ? caps : { ...caps, enabled: false };
  });
  handle("polls:create", async (input: unknown) => {
    if (!POLLS_ON) throw new Error(POLLS_DISABLED_TEXT);
    const me = core.user?.id;
    if (me == null) throw new Error("로그인이 필요합니다");
    const parsed = normalizePollInput(input);
    guardPollRoom({ selfOnly: process.env.UBM_SELF_ONLY === "1", roomSeq: parsed.roomSeq, me, selfRoomSeq: selfRoomApiSeq() });
    const r = await pollsClient().create(parsed);
    if (!r.ok) throw new Error(r.message);
    return r.data;
  });
  handle("polls:get", async (id: unknown) => {
    if (!POLLS_ON) throw new Error(POLLS_DISABLED_TEXT);
    if (core.user == null) throw new Error("로그인이 필요합니다");
    const r = await pollsClient().get(normalizePollId(id));
    if (!r.ok) throw new Error(r.message);
    return r.data;
  });
  handle("polls:vote", async (id: unknown, optionIndex: unknown) => {
    if (!POLLS_ON) throw new Error(POLLS_DISABLED_TEXT);
    const me = core.user?.id;
    if (me == null) throw new Error("로그인이 필요합니다");
    const r = await pollsClient().vote(normalizePollId(id), normalizeOptionIndex(optionIndex));
    if (!r.ok) throw new Error(r.message);
    return r.data;
  });
  handle("polls:close", async (id: unknown) => {
    if (!POLLS_ON) throw new Error(POLLS_DISABLED_TEXT);
    const me = core.user?.id;
    if (me == null) throw new Error("로그인이 필요합니다");
    const r = await pollsClient().close(normalizePollId(id));
    if (!r.ok) throw new Error(r.message);
    return r.data;
  });
  // 메시지 수정 / 답장(인용): M 패턴 (delete+resend / quote). New send paths → self-only guard.
  const EDIT_ON = editEnabled(process.env);
  handle("edit:caps", () => editCaps(process.env));
  handle("msg:edit", async (key: unknown, origMessageId: unknown, newText: unknown) => {
    if (!EDIT_ON) throw new Error(EDIT_DISABLED_TEXT);
    const me = core.user?.id;
    if (me == null) throw new Error("로그인이 필요합니다");
    const room = core.getRooms().find((r) => r.key === key);
    return performEdit({
      guard: () => guardEditReplyTarget({ selfOnly: process.env.UBM_SELF_ONLY === "1", me, selfRoomSeq: selfRoomApiSeq(), room: room ?? null }),
      deleteByIds: (ids) => core.client.deleteChatMessages(ids),
      sendText: (k, t) => core.sendText(k, t),
      roomKey: String(key),
      origMessageId: Number(origMessageId),
      newText: normalizeEditText(newText),
    });
  });
  handle("msg:reply", async (key: unknown, target: unknown, replyText: unknown) => {
    const me = core.user?.id;
    if (me == null) throw new Error("로그인이 필요합니다");
    const room = core.getRooms().find((r) => r.key === key);
    return performReply({
      guard: () => guardEditReplyTarget({ selfOnly: process.env.UBM_SELF_ONLY === "1", me, selfRoomSeq: selfRoomApiSeq(), room: room ?? null }),
      sendText: (k, t) => core.sendText(k, t),
      roomKey: String(key),
      target: normalizeReplyTarget(target),
      replyText: normalizeReplyText(replyText),
    });
  });
  // 유비온봇 대화 요약 / 안 읽은 메시지 요약: posts a /요약 command to the 나 room (bot room).
  // New message-sending path → self-only guard. Behind UBM_BOT_SUMMARY=1 (needs server deploy).
  const BOT_SUMMARY_ON = profile.enhancedServer && botSummaryEnabled(process.env);
  handle("bot:summary:caps", () => {
    const caps = botSummaryCaps(process.env);
    return profile.enhancedServer ? caps : { ...caps, enabled: false };
  });
  handle("bot:summary:request", async (target: unknown, mode: unknown, recentN?: unknown) => {
    if (!BOT_SUMMARY_ON) throw new Error(BOT_SUMMARY_DISABLED_TEXT);
    const me = core.user?.id;
    if (me == null) throw new Error("로그인이 필요합니다");
    const selfRoom = core.getRooms().find((r) => r.isSelf) ?? null;
    const roomKey = normalizeSummaryRoomKey(target);
    const m = normalizeSummaryMode(mode);
    const n = m === "recent" ? normalizeRecentN(recentN) : undefined;
    return performBotSummary({
      guard: () => guardBotSummaryTarget({ selfOnly: process.env.UBM_SELF_ONLY === "1", me, selfRoomSeq: selfRoomApiSeq(), selfRoom }),
      sendText: (k, t) => core.sendText(k, t),
      selfRoomKey: selfRoom?.key ?? "",
      roomKey,
      mode: m,
      recentN: n,
    });
  });
  handle("app:badgeOverlay", (dataUrl: string | null) => {
    if (process.platform !== "win32" || !win) return;
    win.setOverlayIcon(dataUrl ? nativeImage.createFromDataURL(dataUrl) : null, dataUrl ? "읽지 않은 메시지" : "");
  });
  handle("portal:get", (id?: string) => (id ? core.portal.getWidget(id as any) : core.portal.snapshot()));
  handle("portal:refresh", () => core.portal.refreshNow());
  handle("portal:open", (url: string, mode?: "external" | "inapp") => openPortal(String(url), mode));
  handle("portal:menu", (force?: boolean) => core.portal.menu(core.client.baseUrl, !!force));
  handle("portal:setActive", (active: boolean) => core.portal.setHomeActive(!!active));
  handle("portal:mailFolders", () => core.portal.mailFolders());
  handle("portal:mailList", (folder: unknown, page: unknown, keyword: unknown) => {
    const a = normalizeMailListArgs(folder, page, keyword);
    return core.portal.mailList(a.folder, a.page, a.keyword);
  });
  handle("portal:mailRead", (folder: unknown, uid: unknown) => core.portal.mailRead(validFolder(folder), normalizeMailUid(uid)));
  handle("portal:approvalList", (box: unknown, page: unknown, keyword: unknown) => {
    const a = normalizeApprovalListArgs(box, page, keyword);
    return core.portal.approvalList(a.box, a.page, a.keyword);
  });
  handle("portal:approvalCounts", () => core.portal.approvalCounts());
  handle("portal:mailUpload", (name: unknown, data: unknown, mime: unknown) => core.portal.mailUpload(name, data, mime));
  handle("portal:mailCaps", () => core.portal.mailCaps());
  handle("portal:mailDelete", (folder: unknown, uids: unknown) => core.portal.mailDelete(folder, uids));
  handle("portal:mailSend", (draft: unknown) => core.portal.mailSend(draft));
  handle("portal:approvalAction", (kind: unknown, id: unknown, comment: unknown) => core.portal.approvalAction(kind, id, comment));
  handle("portal:approvalDoc", (id: unknown) => core.portal.approvalDoc(normalizeApprovalDocId(id)));
  handle("portal:flexPending", async (force?: boolean) => refreshFlexPending(!!force));
  handle("app:openExternal", (url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
  });
  handle("app:openChatBot", (brandName?: unknown) => {
    const target = chatBotUrl(brandName ?? core.user?.brandName);
    if (!isChatBotUrl(target)) throw new Error("허용되지 않은 주소입니다");
    return shell.openExternal(target);
  });
}

function uniquePath(p: string) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 1; ; i++) {
    const c = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(c)) return c;
  }
}

// ---------- media protocol: authenticated thumbnails/avatars/images ----------
const linkCache = new PreviewCache();
const ogImageCache = new PreviewCache(100);
const mediaCache = new MediaCache(64 * 1024 * 1024, 4 * 1024 * 1024);
function registerMediaProtocol() {
  protocol.handle("ubion-media", async (req) => {
    try {
      const u = new URL(req.url);
      let p = decodeURIComponent(u.pathname.replace(/^\/+/, "/")) + u.search;
      if (p.startsWith("/api/chat/files/") && !/[?&]userSeq=/.test(p) && core.user)
        p += (p.includes("?") ? "&" : "?") + `userSeq=${core.user.id}`;
      const hit = mediaCache.get(p);
      const { data, contentType } = hit || (await core.client.fetchBinary(p));
      if (!hit) mediaCache.set(p, { data, contentType });
      return new Response(new Uint8Array(data), { headers: { "content-type": contentType, "cache-control": "max-age=86400" } });
    } catch {
      return new Response("", { status: 404 });
    }
  });
}

// ---------- embedded <webview> (플렉스 tab) ----------
app.on("web-contents-created", (_e, contents) => {
  if (contents.getType() !== "webview") return;
  attachFlexWindowHooks(contents);
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void openPortalWindow(url);
    else if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const secureNav = (e: Electron.Event, url: string) => {
    if (/^https:\/\//i.test(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  contents.on("will-navigate", secureNav);
  contents.on("will-redirect", secureNav);
});

// ---------- lifecycle ----------
app.on("second-instance", showWindow);
app.on("activate", showWindow);
app.on("before-quit", () => {
  quitting = true;
  awayMonitor?.stop();
  core.shutdown();
  searchCache?.flush();
  savedStore?.flush();
  reminderStore?.flush();
  scheduledStore?.flush();
  clearPreviewTemp();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !settings.closeToTray) app.quit();
});

app.whenReady().then(async () => {
  nativeTheme.themeSource = settings.theme;
  if (process.platform === "darwin") app.dock?.setIcon(nativeImage.createFromPath(resPath("icon-mac.png")));
  applyMainLanguage(settings.language, process.env);
  buildAppMenu();
  lockRecord = loadLockRecord();
  locked = !!lockRecord;
  lockState.reset();
  registerMediaProtocol();
  registerIpc();
  wireCore();
  createTray();
  startHidden = process.argv.includes("--hidden") || !!app.getLoginItemSettings().wasOpenedAsHidden;
  createWindow();
  if (locked) win?.webContents.once("did-finish-load", () => send("lock:changed", { locked: true }));

  updater.schedule(settings.autoUpdate);
  startAwayMonitor();
  powerMonitor.on("resume", () => (core.reconnect(), void core.sync("resume")));
  powerMonitor.on("unlock-screen", () => core.reconnect());
  powerMonitor.on("lock-screen", () => {
    if (lockRecord) lockNow();
  });
});
