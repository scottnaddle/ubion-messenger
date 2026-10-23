/** 다국어 (main): tray/app menu labels via the renderer's dictionaries; rebuilt by main.ts on settings.language change. */
import { effectiveLanguage, i18nEnabled, normalizeLanguage, translate, type I18nCaps, type Language, type Vars } from "../../src/lib/i18n-core";

let current: Language = "ko";

export function setMainLanguage(lang: unknown): Language {
  current = normalizeLanguage(lang);
  return current;
}

export function i18nCaps(env: Record<string, string | undefined>): I18nCaps {
  return { enabled: i18nEnabled(env) };
}

/** Apply settings.language to main menus, forced to "ko" unless UBM_I18N=1. */
export function applyMainLanguage(saved: unknown, env: Record<string, string | undefined>): Language {
  return setMainLanguage(effectiveLanguage(saved, i18nEnabled(env)));
}

/** settings:set: language selector is hidden in 1.0.21, so drop language patches unless UBM_I18N=1 (saved value kept). */
export function filterLanguagePatch<T extends { language?: unknown }>(patch: T, env: Record<string, string | undefined>): T {
  if (!("language" in patch)) return patch;
  if (i18nEnabled(env)) patch.language = normalizeLanguage(patch.language);
  else delete patch.language;
  return patch;
}

export function getMainLanguage(): Language {
  return current;
}

export function tm(key: string, vars?: Vars): string {
  return translate(current, key, vars);
}
