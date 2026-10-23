import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { normalizePreset, normalizeThemeState, type CustomTheme, type ThemePresetId } from "./core/theme";

export type Settings = {
  serverUrl: string;
  username: string;
  rememberMe: boolean;
  autoLogin: boolean;
  theme: "system" | "light" | "dark";
  notifications: boolean;
  notificationPreview: boolean;
  notificationSound: boolean;
  launchAtLogin: boolean;
  closeToTray: boolean;
  downloadDir: string;
  /** 채팅 파일 "저장" 시 매번 위치 묻기 */
  askSaveLocation: boolean;
  /** last folder used by 다른 이름으로 저장 */
  lastSaveDir?: string;
  fontSize: number;
  autoUpdate: boolean;
  /** OS notification for new 전사게시판 posts */
  portalPostNotify: boolean;
  /** how portal items open: in-app window with the messenger's session (default, SSO) or external browser */
  portalOpenMode: "external" | "inapp";
  /** true once the user explicitly picked portalOpenMode in settings (≤1.0.5 persisted "external" without a UI). */
  portalOpenModeChosen?: boolean;
  /** Hidden (no UI): allow plaintext XMPP TCP 5222 if BOSH/HTTPS cannot connect. Off by default. */
  xmppTcpFallback: boolean;
  /** Auto-fill flex.team login with portal email (username@ubion.co.kr) + saved portal password. */
  flexAutoLogin: boolean;
  /** Highest 전사게시판 post id seen (number only) — lets posts made while the app was closed notify on next start. */
  portalLastPostId?: number;
  /** accountKey()s (host|loginid, no secrets) that need the web-login window (OTP / 2-step). */
  webLoginAccounts?: string[];
  /** 자리비움 전환까지 기다리는 시간(분). 0 = 설정 안 함. */
  awayMinutes: 0 | 1 | 5 | 10 | 15;
  /** 부재 시 모바일 알림 선호(로컬 저장 전용, 서버 정책에 따라 동작). */
  mobileNotice: boolean;
  /** 자동 잠금까지의 유휴 시간(분). 0 = 자동 잠금 안 함. */
  lockTimeoutMin: 0 | 1 | 5 | 10 | 30 | 60;
  /** Built-in color preset (CSS-variable overrides in styles.css). */
  themePreset: ThemePresetId;
  /** 테마 업로드: metadata only — CSS text lives in userData/themes/<id>.css. */
  customThemes: CustomTheme[];
  /** id of the applied custom theme, "" = none. */
  activeThemeId: string;
};

export const DEFAULTS: Settings = {
  serverUrl: "https://coco.ubion.co.kr",
  username: "",
  rememberMe: true,
  autoLogin: false,
  theme: "system",
  notifications: true,
  notificationPreview: true,
  notificationSound: true,
  launchAtLogin: false,
  closeToTray: true,
  downloadDir: "",
  askSaveLocation: false,
  fontSize: 14,
  autoUpdate: true,
  portalPostNotify: true,
  portalOpenMode: "inapp",
  xmppTcpFallback: false,
  flexAutoLogin: true,
  awayMinutes: 10,
  mobileNotice: true,
  lockTimeoutMin: 0,
  themePreset: "default",
  customThemes: [],
  activeThemeId: "",
};

const file = () => path.join(app.getPath("userData"), "settings.json");
const secretFile = () => path.join(app.getPath("userData"), "credential.bin");

export function loadSettings(): Settings {
  try {
    const s: Settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), "utf8")) };
    if (!s.portalOpenModeChosen) s.portalOpenMode = DEFAULTS.portalOpenMode; // 1.0.6 migration: SSO in-app by default
    const themes = normalizeThemeState(s.customThemes, s.activeThemeId);
    s.customThemes = themes.themes;
    s.activeThemeId = themes.activeThemeId;
    s.themePreset = normalizePreset(s.themePreset);
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(s, null, 2));
}

/** Password is stored only via OS keychain-backed safeStorage (Keychain / DPAPI). */
export function savePassword(pw: string) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  fs.writeFileSync(secretFile(), safeStorage.encryptString(pw), { mode: 0o600 });
  return true;
}

export function loadPassword(): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(fs.readFileSync(secretFile()));
  } catch {
    return null;
  }
}

export function clearPassword() {
  try {
    fs.unlinkSync(secretFile());
  } catch {
    /* none */
  }
}
