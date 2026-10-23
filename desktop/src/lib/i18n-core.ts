/**
 * 다국어: pure translation core shared by the renderer (src/lib/i18n.ts) and main (electron/core/i18n-main.ts).
 * Keys are the Korean source strings themselves; missing translations fall back to Korean.
 */
import en from "./locales/en";
import ja from "./locales/ja";
import vi from "./locales/vi";
import zh_CN from "./locales/zh_CN";
import zh_TW from "./locales/zh_TW";

export const LANGUAGES = ["ko", "en", "ja", "zh_CN", "zh_TW", "vi"] as const;
export type Language = (typeof LANGUAGES)[number];
export type Dict = Readonly<Record<string, string>>;
export type Vars = Record<string, string | number | null | undefined>;

/** Names shown in the selector, each in its own language. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  ko: "한국어", en: "English", ja: "日本語", zh_CN: "简体中文", zh_TW: "繁體中文", vi: "Tiếng Việt",
};

export const DICTIONARIES: Record<Language, Dict> = { ko: {}, en, ja, zh_CN, zh_TW, vi };

export function normalizeLanguage(v: unknown): Language {
  return typeof v === "string" && (LANGUAGES as readonly string[]).includes(v) ? (v as Language) : "ko";
}

/**
 * 1.0.21 (company-only): multi-language is hidden and the UI is always Korean unless UBM_I18N=1 (read in main,
 * exposed via the i18n:caps IPC). Dictionaries stay in place; the OS locale is never consulted.
 */
export type I18nCaps = { enabled: boolean };

export function i18nEnabled(env: Record<string, string | undefined>): boolean {
  return env.UBM_I18N === "1";
}

/** Language actually applied: the saved setting when the flag is on, otherwise always "ko". */
export function effectiveLanguage(saved: unknown, enabled: boolean): Language {
  return enabled ? normalizeLanguage(saved) : "ko";
}

/** {name} → vars.name; unknown placeholders are left as-is. */
export function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars && vars[k] != null ? String(vars[k]) : m));
}

export function translate(lang: Language, key: string, vars?: Vars): string {
  const hit = DICTIONARIES[lang]?.[key];
  return interpolate(hit || key, vars);
}

/** Identity marker for keys stored in data tables and translated later with t(value); seen by the key scanner. */
export const tk = (key: string): string => key;
