/** 다국어 (main): tray/app menu labels via the renderer's dictionaries; rebuilt by main.ts on settings.language change. */
import { normalizeLanguage, translate, type Language, type Vars } from "../../src/lib/i18n-core";

let current: Language = "ko";

export function setMainLanguage(lang: unknown): Language {
  current = normalizeLanguage(lang);
  return current;
}

export function getMainLanguage(): Language {
  return current;
}

export function tm(key: string, vars?: Vars): string {
  return translate(current, key, vars);
}
