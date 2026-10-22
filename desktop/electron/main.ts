import {
  app,
  BrowserWindow,
  dialog,
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
import { HttpError } from "./core/daou-client";
import type { MessengerEventMap } from "./core/types";
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
    core.on("rooms", () => updateBadge()),
    core.on("message", (m) => maybeNotify(m)),
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
function openPortal(rel: string, _mode?: "external" | "inapp") {
  const url = portalUrl(rel);
  if (!url) throw new Error("허용되지 않은 주소입니다");
  // MVP: always external browser (session is not shared; user may need to sign in on the web).
  return shell.openExternal(url);
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
      return user;
    }
  );
  handle("auth:logout", async () => {
    await core.logout("user");
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
  handle("portal:setActive", (active: boolean) => core.portal.setHomeActive(!!active));
  handle("app:openExternal", (url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
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
  core.shutdown();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !settings.closeToTray) app.quit();
});

app.whenReady().then(async () => {
  nativeTheme.themeSource = settings.theme;
  if (process.platform === "darwin") app.dock?.setIcon(nativeImage.createFromPath(resPath("icon.png")));
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
