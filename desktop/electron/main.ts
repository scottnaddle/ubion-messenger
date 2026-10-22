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
import { Updater } from "./updater";
import { IS_TEST_BUILD } from "./flavor";
import { setAllRooms, setManyRoomsCollecting, setRoomCollecting } from "./core/todo/rooms";
import { HttpError } from "./core/daou-client";
import type { MessengerEventMap } from "./core/types";
import { isPortalUrl, isFlexUrl, isFlexSsoUrl, toElectronCookie } from "./core/portal-cookies";
import {
  isFlexLoginUrl, flexEmailFromUsername, flexAutoLoginScript, maskFlexLog,
  FLEX_TODO_SEARCH, FLEX_TODO_PENDING_BODY, parseFlexTodoTotal, flexProgressCountFromText,
} from "./core/flex";
import { normalizeApprovalDocId, normalizeApprovalListArgs } from "./core/portal";
import { TodoService } from "./core/todo/service";
import { WizardService } from "./core/wizard/service";
import {
  clearPassword,
  loadPassword,
  loadSettings,
  savePassword,
  saveSettings,
  type Settings,
} from "./settings";

const APP_NAME = IS_TEST_BUILD ? "UBION Messenger Test" : "UBION Messenger";
app.setName(APP_NAME);
if (IS_TEST_BUILD && !app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", path.join(app.getPath("appData"), "UBION Messenger Test"));
}
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
let core = new MessengerCore(settings.serverUrl);
let unsubscribe: Array<() => void> = [];
let startHidden = false;
const updater = new Updater(() => win);
const todoService = new TodoService(path.join(__dirname, "../../resources"));
const wizardService = new WizardService();

const resPath = (f: string) =>
  app.isPackaged ? path.join(process.resourcesPath, "resources", f) : path.join(__dirname, "../../resources", f);

function send(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function errMsg(e: unknown): string {
  if (e instanceof HttpError && e.status === 401) return "인증이 만료되었습니다. 다시 로그인해 주세요.";
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
      maybeNotify(m);
      try {
        const ev = todoService.handleMessage(m, m.roomKey, m.roomKind, m.isMine, core.user?.id);
        if (ev) send("core:event", { type: "todo", payload: ev });
      } catch (e) {
        console.warn("todo pipeline:", (e as Error).message);
      }
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
  if (m.isMine || !settings.notifications || !m.usePush) return;
  const viewing = win?.isFocused() && core.activeRoomKey === m.roomKey;
  if (viewing || !Notification.isSupported()) return;
  const room = core.getRooms().find((r) => r.key === m.roomKey);
  const title = room && room.kind !== "buddy" ? `${room.name} · ${m.sendUserName}` : m.sendUserName || APP_NAME;
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
      const password = o.password || (o.rememberMe ? loadPassword() : null);
      if (!password) throw new Error("비밀번호를 입력하세요");
      const serverUrl = (o.serverUrl || settings.serverUrl).trim().replace(/\/$/, "");
      if (!/^https?:\/\//.test(serverUrl)) throw new Error("서버 주소는 https:// 로 시작해야 합니다");
      if (core.user) await core.logout();
      core = new MessengerCore(serverUrl);
      wireCore();
      const user = await core.login({ serverUrl, username: o.username.trim(), password });
      settings = { ...settings, serverUrl, username: o.username.trim(), rememberMe: o.rememberMe, autoLogin: o.rememberMe && o.autoLogin };
      saveSettings(settings);
      if (o.rememberMe) savePassword(password);
      else clearPassword();
      flexAutoLoginTried = false;
      flexPendingCache = { count: null, at: 0 };
      return user;
    }
  );
  handle("auth:logout", async () => {
    await core.logout("user");
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
  handle("rooms:openDirect", (userId: number) => core.openDirect(userId));
  handle("rooms:createGroup", (ids: number[]) => core.createGroup(ids));
  handle("msg:history", async (key: string, before?: number) => {
    const list = await core.history(key, before);
    core.noteSeen(key, list);
    try {
      const room = core.getRooms().find((r) => r.key === key);
      for (const m of list) {
        const isMine = !!core.user && m.sendUserSeq === core.user.id;
        todoService.handleMessage(m, key, room?.kind || "unknown", isMine, core.user?.id, true);
      }
    } catch { /* ignore */ }
    return list;
  });
  handle("rooms:sync", () => core.sync("manual"));
  handle("rooms:members", (key: string) => core.members(key));
  handle("msg:search", (key: string, kw: string) => core.searchInRoom(key, kw));
  handle("msg:send", (key: string, text: string) => core.sendText(key, text));
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
  handle("update:status", () => ({ ...updater.status, supported: updater.supported, platform: process.platform }));
  handle("update:check", () => updater.check());
  handle("update:download", () => updater.downloadMac());
  handle("update:install", () => updater.install());
  handle("update:openPage", () => updater.openReleasePage());
  handle("org:users", (force?: boolean) => core.users(force));
  handle("org:departments", () => core.departments());
  handle("org:presence", () => core.allPresence());
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
  handle("portal:approvalList", (box: unknown, page: unknown, keyword: unknown) => {
    const a = normalizeApprovalListArgs(box, page, keyword);
    return core.portal.approvalList(a.box, a.page, a.keyword);
  });
  handle("portal:approvalCounts", () => core.portal.approvalCounts());
  handle("portal:approvalDoc", (id: unknown) => core.portal.approvalDoc(normalizeApprovalDocId(id)));
  handle("portal:flexPending", async (force?: boolean) => refreshFlexPending(!!force));
  handle("app:openExternal", (url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
  });
  // ---- todos / schedule / zoom (v1.1) ----
  handle("todo:list", (filter?: { status?: string; type?: string }) => todoService.store.list(filter as any));
  handle("todo:get", (id: string) => todoService.store.get(String(id)));
  handle("todo:add", (input: any) => todoService.store.add(input));
  handle("todo:update", (id: string, patch: any) => {
    const r = todoService.store.update(String(id), patch);
    if (!r) throw new Error("할일을 찾을 수 없습니다");
    return r;
  });
  handle("todo:complete", (id: string) => {
    const r = todoService.store.complete(String(id));
    if (!r) throw new Error("할일을 찾을 수 없습니다");
    return r;
  });
  handle("todo:delete", (id: string) => {
    todoService.store.remove(String(id));
  });
  handle("todo:suggestions", () => todoService.store.suggestions());
  handle("todo:acceptSuggestion", (id: string) => {
    const r = todoService.store.acceptSuggestion(String(id));
    if (!r) throw new Error("제안을 찾을 수 없습니다");
    send("core:event", { type: "todo", payload: { type: "auto", item: r } });
    return r;
  });
  handle("todo:rejectSuggestion", (id: string) => {
    todoService.store.rejectSuggestion(String(id));
  });
  handle("todo:settings:get", () => todoService.settings());
  handle("todo:settings:set", (patch: any) => todoService.store.updateSettings(patch || {}));
  handle("todo:enableRoom", (roomKey: string, on: boolean) =>
    todoService.store.updateSettings(setRoomCollecting(todoService.settings(), String(roomKey), !!on)));
  handle("todo:enableRooms", (keys: string[], on: boolean) =>
    todoService.store.updateSettings(setManyRoomsCollecting(todoService.settings(), (keys || []).map(String), !!on)));
  handle("todo:setAllRooms", (on: boolean) =>
    todoService.store.updateSettings(setAllRooms(todoService.settings(), !!on)));
  handle("todo:llm:status", () => ({ hasKey: todoService.store.hasLlmKey() }));
  handle("todo:llm:setKey", (key: string | null) => {
    todoService.store.setLlmKey(key ? String(key) : null);
    return { hasKey: todoService.store.hasLlmKey() };
  });
  handle("todo:llm:test", () => todoService.llmClient().test().then((r) => ({ ok: r.ok, message: r.message })));
  handle("todo:roomOn", (roomKey: string) => todoService.store.isRoomEnabled(String(roomKey)));
  handle("todo:deleteAllExtracted", () => {
    todoService.store.deleteAllExtracted();
  });
  handle("todo:exportIcs", async () => {
    const ics = todoService.exportIcs();
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: path.join(settings.downloadDir || app.getPath("downloads"), "ubion-todos.ics"),
      filters: [{ name: "iCalendar", extensions: ["ics"] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, ics, "utf8");
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  });
  handle("todo:schedule", () => {
    const todos = todoService.store.list({ status: "open" }).filter((t) => t.due || t.start);
    const cal = core.portal.getWidget("calendar");
    return { todos, calendar: cal };
  });
  handle("zoom:join", (todoId: string) => todoService.joinZoom(String(todoId)));
  handle("todo:undoAuto", (id: string) => {
    todoService.store.remove(String(id));
  });

  // ---- wizard / 위저드 (Cmd+K launcher) ----
  handle("wizard:refresh", async () => {
    const menu = await core.portal.menu(core.client.baseUrl, false);
    const n = await wizardService.refresh(menu.items, async (path) => {
      const res = await core.client.request(path, { method: "GET" });
      if (res.status !== 200) {
        const e = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        e.status = res.status;
        throw e;
      }
      try {
        return JSON.parse(res.text);
      } catch {
        throw new Error("invalid JSON");
      }
    });
    return { count: n, at: Date.now() };
  });
  handle("wizard:search", (q?: string) => wizardService.search(String(q || ""), 24));
  handle("wizard:pin", (id: string, on: boolean) => wizardService.pin(String(id), !!on));
  handle("wizard:open", (id: string) => {
    const item = wizardService.list().find((h) => h.id === String(id));
    if (!item) throw new Error("항목을 찾을 수 없습니다");
    wizardService.recordOpen(item.id);
    return item;
  });
  handle("wizard:prefs", () => wizardService.store.get());

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
function registerMediaProtocol() {
  protocol.handle("ubion-media", async (req) => {
    try {
      const u = new URL(req.url);
      let p = decodeURIComponent(u.pathname.replace(/^\/+/, "/")) + u.search;
      if (p.startsWith("/api/chat/files/") && !/[?&]userSeq=/.test(p) && core.user)
        p += (p.includes("?") ? "&" : "?") + `userSeq=${core.user.id}`;
      const { data, contentType } = await core.client.fetchBinary(p);
      return new Response(data, { headers: { "content-type": contentType, "cache-control": "max-age=86400" } });
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
  todoService.stop();
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
  wizardService.start();
  todoService.start({
    resourcesDir: path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, "../.."), "resources"),
    onPipeline: (ev) => send("core:event", { type: "todo", payload: ev }),
    getCalendarBusy: () => {
      try {
        const cal = core.portal.getWidget("calendar") as any;
        const items = cal?.items || [];
        const now = Date.now();
        return items.some((e: any) => {
          const a = e.start ? new Date(e.start).getTime() : 0;
          const b = e.end ? new Date(e.end).getTime() : a + 3600000;
          return a <= now && now <= b;
        });
      } catch {
        return false;
      }
    },
  });
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
