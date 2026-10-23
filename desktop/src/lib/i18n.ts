/**
 * 다국어 (renderer): t(key) where key is the Korean source string, {var} interpolation, Korean fallback.
 * Components call `const t = useT()` so they re-render when settings.language changes;
 * plain helpers may import the module-level `t` (current language at call time).
 */
import { useSyncExternalStore } from "react";
import { normalizeLanguage, translate, type Language, type Vars } from "./i18n-core";

export { LANGUAGES, LANGUAGE_NAMES, normalizeLanguage, tk, type Language } from "./i18n-core";

let current: Language = "ko";
const listeners = new Set<() => void>();

export function getLanguage(): Language {
  return current;
}

export function setLanguage(lang: unknown) {
  const next = normalizeLanguage(lang);
  if (next === current) return;
  current = next;
  if (typeof document !== "undefined") document.documentElement.lang = next.replace("_", "-");
  listeners.forEach((l) => l());
}

export function t(key: string, vars?: Vars): string {
  return translate(current, key, vars);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** React hook: returns t bound to the current language; re-renders on language change. */
export function useT(): (key: string, vars?: Vars) => string {
  const lang = useSyncExternalStore(subscribe, getLanguage, getLanguage);
  return (key, vars) => translate(lang, key, vars);
}
