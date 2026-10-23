import { resolveSaveTarget, type SaveMode } from "./core/save-path";
import {
  app,
  BrowserWindow,
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
  shell,
  Tray,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { MessengerCore } from "./core/messenger";
import { fetchLinkPreview, fetchPreviewImage, PreviewCache } from "./core/link-preview";
import { MediaCache } from "./core/media-cache";
import { Updater } from "./updater";
import { HttpError } from "./core/daou-client";
import type { MessengerEventMap } from "./core/types";
import { isPortalUrl, isFlexUrl, isFlexSsoUrl, toElectronCookie } from "./core/portal-cookies";
import {
  isFlexLoginUrl, flexEmailFromUsername, flexAutoLoginScript, maskFlexLog,
  FLEX_TODO_SEARCH, FLEX_TODO_PENDING_BODY, parseFlexTodoTotal, flexProgressCountFromText,
} from "./core/flex";
import { normalizeApprovalDocId, normalizeApprovalListArgs } from "./core/portal";
import { shouldNotify } from "./core/room-push";
import { chatBotUrl, isChatBotUrl } from "./core/chatbot";
import { isMentioningMe } from "../src/lib/mention";
import { normalizeMailListArgs, normalizeMailUid, validFolder } from "./core/mail";
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

const APP_NAME = "UBION Messenger";
app.setName(APP_NAME);
if (process.platform === "win32") app.setAppUserModelId("global.ubion.messenger");

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
const updater = new Updater(() => win);

const resPath = (f: string) =>
  app.isPackaged ? path.join(process.resourcesPath, "resources", f) : path.join(__dirname, "../../resources", f);

function send(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
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
    fwd("message"),
    fwd("confirm"),
    fwd("receipts"),
    fwd("presence"),
    fwd("connection"),
    fwd("loggedOut"),
    fwd("portalSummary"),
    fwd("portalWidget"),
    fwd("portalBadge"),
    core.on("portalNewPost", (p) => notifyNewPost(p)),
    core.on("portalNewPostSummary", (p) => notifyNewPostSummary(p)),
    core.on("rooms", () => updateBadge()),
    core.on("message", (m) => {
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
  tray?.setToolTip(n ? `${APP_NAME} — 읽지 않은 메시지 ${n}` : APP_NAME);
  rebuildTrayMenu(n);
}

function rebuildTrayMenu(n = core.unreadTotal()) {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: n ? `읽지 않은 메시지 ${n}개` : "새 메시지 없음", enabled: false },
      { type: "separator" },
      { label: "UBION Messenger 열기", click: showWindow },
      { label: "설정", click: () => (showWindow(), send("nav:settings", null)) },
      { type: "separator" },
      { label: "종료", click: () => ((quitting = true), app.quit()) },
    ])
  );
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
  await portalSession().clearStorageData().catch(() => undefined);
}

function portalNavMenu() {
  // Window menu bar (Windows) / app menu while focused: back, forward, reload, open in external browser.
  return Menu.buildFromTemplate([
    { label: "◀ 뒤로", accelerator: "CmdOrCtrl+[", click: () => portalWin?.webContents.navigationHistory.goBack() },
    { label: "앞으로 ▶", accelerator: "CmdOrCtrl+]", click: () => portalWin?.webContents.navigationHistory.goForward() },
    { label: "새로고침", accelerator: "CmdOrCtrl+R", click: () => portalWin?.webContents.reload() },
    { label: "외부 브라우저로 열기", click: () => { const u = portalWin?.webContents.getURL(); if (u && /^https?:/.test(u)) void shell.openExternal(u); } },
  ]);
}


async function tryFlexAutoLogin(wc: BrowserWindow["webContents"]) {
  if (flexAutoLoginTried || !settings.flexAutoLogin || !settings.rememberMe) return;
  const url = wc.getURL();
  if (!isFlexLoginUrl(url)) return;
  const email = flexEmailFromUsername(settings.username);
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

function attachFlexWindowHooks(w: BrowserWindow) {
  const wc = w.webContents;
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
      width: 980, height: 760, title: "웹 로그인 — UBION Messenger", parent: win ?? undefined, modal: !!win,
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
    width: 1280, height: 860, title: "DaouOffice — UBION Messenger", autoHideMenuBar: false,
    webPreferences: { partition: PORTAL_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  portalWin.setMenu(portalNavMenu());
  attachFlexWindowHooks(portalWin);
  const base = core.client.baseUrl;
  const inWin = (u: string) => isPortalUrl(u, base) || isFlexUrl(u) || isFlexSsoUrl(u);
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

function notifyNewPost(p: MessengerEventMap["portalNewPost"]) {
  if (!settings.notifications || !settings.portalPostNotify || !Notification.isSupported()) return;
  const n = new Notification({
    title: `전사게시판${p.boardName ? ` · ${p.boardName}` : ""}: 새 글`,
    body: settings.notificationPreview ? p.summary.slice(0, 140) : "새 글이 등록되었습니다",
    silent: !settings.notificationSound,
  });
  n.on("click", () => void openPortal(p.url).catch(() => undefined));
  n.show();
}

function notifyNewPostSummary(p: MessengerEventMap["portalNewPostSummary"]) {
  if (!settings.notifications || !settings.portalPostNotify || !Notification.isSupported()) return;
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
  const body = settings.notificationPreview
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

function applyLoginItem() {
  if (process.platform === "linux") return;
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, openAsHidden: true, args: ["--hidden"] });
}

// ---------- IPC ----------
function registerIpc() {
  handle("app:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    encryption: (() => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    })(),
  }));
  handle("settings:get", () => ({ ...settings, hasSavedPassword: !!(settings.rememberMe && loadPassword()) }));
  handle("settings:set", (patch: Partial<Settings>) => {
    settings = { ...settings, ...patch };
    saveSettings(settings);
    if ("launchAtLogin" in patch) applyLoginItem();
    if ("theme" in patch) nativeTheme.themeSource = settings.theme;
    if ("autoUpdate" in patch) updater.schedule(settings.autoUpdate);
    if (patch.rememberMe === false) {
      clearPassword();
      settings.autoLogin = false;
      saveSettings(settings);
    }
    return settings;
  });

  handle("auth:state", () => ({ user: core.user, conn: core.conn }));
  handle(
    "auth:login",
    async (o: { serverUrl: string; username: string; password?: string; rememberMe: boolean; autoLogin: boolean }) => {
      // Saved password belongs to settings.username only; never reuse it for a different account.
      const sameUser = o.username.trim() === (settings.username || "").trim();
      const password = o.password || (o.rememberMe && sameUser ? loadPassword() : null);
      const serverUrl = (o.serverUrl || settings.serverUrl).trim().replace(/\/$/, "");
      if (!/^https?:\/\//.test(serverUrl)) throw new Error("서버 주소는 https:// 로 시작해야 합니다");
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
      if (core.user) await core.logout();
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
    const serverUrl = (o?.serverUrl || settings.serverUrl).trim().replace(/\/$/, "");
    if (!/^https?:\/\//.test(serverUrl)) throw new Error("서버 주소는 https:// 로 시작해야 합니다");
    return openWebLogin(serverUrl); // SessionUser, or null if the user closed the window
  });
  handle("auth:logout", async () => {
    await core.logout("user");
    mediaCache.clear();
    await clearPortalSession();
    flexAutoLoginTried = false;
    flexPendingCache = { count: null, at: 0 };
    settings = { ...settings, autoLogin: false };
    saveSettings(settings);
    updateBadge();
  });

  handle("rooms:list", () => core.getRooms());
  handle("rooms:refresh", () => core.refreshRooms());
  handle("rooms:setActive", (key: string | null) => core.setActiveRoom(key));
  handle("rooms:pin", (key: string, pin: boolean) => core.setPin(key, pin));
  handle("rooms:setPush", (key: string, usePush: boolean) => core.setRoomPush(key, !!usePush));
  handle("rooms:openDirect", (userId: number) => core.openDirect(userId));
  handle("rooms:createGroup", (ids: number[]) => core.createGroup(ids));
  handle("msg:history", async (key: string, before?: number) => {
    const list = await core.history(key, before);
    core.noteSeen(key, list);
    return list;
  });
  handle("rooms:sync", () => core.sync("manual"));
  handle("rooms:members", (key: string) => core.members(key));
  handle("msg:search", (key: string, kw: string) => core.searchInRoom(key, kw));
  handle("msg:send", (key: string, text: string) => core.sendText(key, text));
  handle("msg:delete", (ids: unknown) => core.client.deleteChatMessages(ids));
  handle("msg:markRead", (key: string, mid?: number) => core.markRead(key, mid));
  handle("files:sendPaths", async (key: string, paths: string[]) => {
    for (const p of paths) {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      if (st.size > 300 * 1024 * 1024) throw new Error(`${path.basename(p)}: 300MB를 초과합니다`);
      await core.sendFile(key, { name: path.basename(p), data: fs.readFileSync(p), mime: guessMime(p) });
    }
  });
  handle("files:sendBuffer", (key: string, name: string, data: ArrayBuffer, mime?: string) =>
    core.sendFile(key, { name, data: Buffer.from(data), mime })
  );
  handle("files:pick", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openFile", "multiSelections"] });
    return r.canceled ? [] : r.filePaths;
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
  handle("files:showInFolder", (p: string) => {
    if (typeof p === "string" && savedPaths.has(p)) shell.showItemInFolder(p);
  });
  handle("settings:pickDownloadDir", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"], defaultPath: settings.downloadDir || app.getPath("downloads") });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
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

function guessMime(p: string) {
  const ext = path.extname(p).toLowerCase().slice(1);
  const m: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    pdf: "application/pdf", txt: "text/plain", zip: "application/zip",
  };
  return m[ext] || "application/octet-stream";
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

// ---------- lifecycle ----------
app.on("second-instance", showWindow);
app.on("activate", showWindow);
app.on("before-quit", () => {
  quitting = true;
  core.shutdown();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !settings.closeToTray) app.quit();
});

app.whenReady().then(async () => {
  nativeTheme.themeSource = settings.theme;
  if (process.platform === "darwin") app.dock?.setIcon(nativeImage.createFromPath(resPath("icon-mac.png")));
  Menu.setApplicationMenu(
    process.platform === "darwin"
      ? Menu.buildFromTemplate([
          { role: "appMenu" },
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ])
      : null
  );
  registerMediaProtocol();
  registerIpc();
  wireCore();
  createTray();
  startHidden = process.argv.includes("--hidden") || !!app.getLoginItemSettings().wasOpenedAsHidden;
  createWindow();

  updater.schedule(settings.autoUpdate);
  powerMonitor.on("resume", () => (core.reconnect(), void core.sync("resume")));
  powerMonitor.on("unlock-screen", () => core.reconnect());
  let away = false;
  setInterval(() => {
    const idle = powerMonitor.getSystemIdleTime() > 600;
    if (idle !== away) {
      away = idle;
      core.setAway(idle);
    }
  }, 30_000);
});
