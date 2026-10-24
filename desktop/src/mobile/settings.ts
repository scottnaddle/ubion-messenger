/** Mobile settings: same shape/defaults as electron/settings.ts, persisted via the platform KvStore (no secrets). */
import type { Settings } from "../api";
import { normalizeDndDays, normalizeDndMin } from "../../electron/core/dnd";
import { normalizePreset } from "../../electron/core/theme";
import { getJson, setJson, type KvStore } from "../platform/storage";

export const SETTINGS_KEY = "settings";

/** Mirrors electron/settings.ts DEFAULTS; desktop-only switches (tray, login item, updater) are off. */
export const MOBILE_DEFAULTS: Settings = {
  serverUrl: "https://coco.ubion.co.kr",
  username: "",
  rememberMe: true,
  autoLogin: false,
  theme: "system",
  notifications: true,
  notificationPreview: true,
  notificationSound: true,
  launchAtLogin: false,
  closeToTray: false,
  downloadDir: "",
  askSaveLocation: false,
  fontSize: 14,
  autoUpdate: false,
  portalPostNotify: true,
  portalOpenMode: "external",
  flexAutoLogin: false,
  awayMinutes: 10,
  mobileNotice: true,
  lockTimeoutMin: 0,
  dndEnabled: false,
  dndDays: [],
  dndStartMin: 1320,
  dndEndMin: 480,
  themePreset: "default",
  customThemes: [],
  activeThemeId: "",
  language: "ko",
  hasSavedPassword: false,
};

/** Keys that must never be persisted in plain preferences. */
const SECRET_KEYS = ["password", "pw", "cookie", "cookies", "token"];

export function sanitizeForStorage(s: Settings): Settings {
  const out: Record<string, unknown> = { ...s };
  for (const k of Object.keys(out)) if (SECRET_KEYS.includes(k.toLowerCase())) delete out[k];
  // TODO(keychain): until a Keychain/Keystore plugin exists the password is never saved on mobile.
  out.hasSavedPassword = false;
  return out as Settings;
}

/** Apply a renderer patch the way main's settings:set does (theme files, i18n and secrets are not settable here). */
export function applySettingsPatch(current: Settings, input: Partial<Settings> | null | undefined): Settings {
  const { customThemes: _ct, activeThemeId: _at, hasSavedPassword: _hp, language: _lang, ...patch } = { ...(input || {}) } as Partial<Settings>;
  for (const k of Object.keys(patch)) if (SECRET_KEYS.includes(k.toLowerCase())) delete (patch as Record<string, unknown>)[k];
  if ("themePreset" in patch) patch.themePreset = normalizePreset(patch.themePreset);
  if ("dndDays" in patch) patch.dndDays = normalizeDndDays(patch.dndDays);
  if ("dndStartMin" in patch) patch.dndStartMin = normalizeDndMin(patch.dndStartMin);
  if ("dndEndMin" in patch) patch.dndEndMin = normalizeDndMin(patch.dndEndMin);
  let next: Settings = { ...current, ...patch };
  if (patch.rememberMe === false) next = { ...next, autoLogin: false };
  return { ...next, hasSavedPassword: false };
}

export async function loadMobileSettings(store: KvStore): Promise<Settings> {
  const saved = await getJson<Partial<Settings>>(store, SETTINGS_KEY);
  const s: Settings = { ...MOBILE_DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
  s.themePreset = normalizePreset(s.themePreset);
  s.customThemes = [];
  s.activeThemeId = "";
  s.language = "ko";
  return { ...s, hasSavedPassword: false };
}

export function saveMobileSettings(store: KvStore, s: Settings): Promise<void> {
  return setJson(store, SETTINGS_KEY, sanitizeForStorage(s));
}
