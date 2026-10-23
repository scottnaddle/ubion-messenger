/**
 * 테마 업로드: user-supplied CSS files layered over styles.css, plus built-in color presets.
 * Pure helpers only (no fs / electron) — main.ts does the dialog + userData/themes/<id>.css I/O.
 */

/** Imported CSS larger than this is refused (before and after sanitizing). */
export const THEME_MAX_BYTES = 256 * 1024;
export const THEME_NAME_MAX = 40;
/** Renderer <style> element that carries the active custom theme. */
export const THEME_STYLE_ID = "ubm-custom-theme";

export type ThemePresetId = "default" | "blue" | "green" | "purple";
/** Implemented in styles.css as `[data-preset="…"]` CSS-variable overrides. */
export const THEME_PRESETS: { id: ThemePresetId; name: string; swatch: string }[] = [
  { id: "default", name: "기본", swatch: "#3a5bdc" },
  { id: "blue", name: "블루", swatch: "#0a84d6" },
  { id: "green", name: "그린", swatch: "#1f9d6b" },
  { id: "purple", name: "퍼플", swatch: "#7c4ddb" },
];

export function normalizePreset(v: unknown): ThemePresetId {
  return THEME_PRESETS.some((p) => p.id === v) ? (v as ThemePresetId) : "default";
}

/** Metadata kept in settings.json; the CSS text itself lives in userData/themes/<id>.css. */
export type CustomTheme = { id: string; name: string; enabled: boolean };
export type ThemeState = { themes: CustomTheme[]; activeThemeId: string };

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isValidThemeId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

/** `theme-<base36 time>-<hex>`; `rand` is injectable for tests. */
export function newThemeId(now = Date.now(), rand: () => number = Math.random): string {
  const hex = Math.floor(rand() * 0xffffff).toString(16).padStart(6, "0");
  return `theme-${now.toString(36)}-${hex}`;
}

/** File name under the themes dir. Throws on anything that is not a generated id (no path traversal). */
export function themeFileName(id: unknown): string {
  if (!isValidThemeId(id)) throw new Error("잘못된 테마 ID입니다");
  return `${id}.css`;
}

/** Display name from the picked file path: basename without `.css`, control chars stripped, length-capped. */
export function themeNameFromPath(p: string): string {
  const base = String(p || "").split(/[\\/]/).pop() || "";
  const name = base.replace(/\.css$/i, "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (name || "사용자 테마").slice(0, THEME_NAME_MAX);
}

export function isCssFileName(p: string): boolean {
  return /\.css$/i.test(String(p || ""));
}

/** Byte-size gate (UTF-8). */
export function checkThemeSize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error("테마 파일을 읽을 수 없습니다");
  if (bytes > THEME_MAX_BYTES) throw new Error(`테마 파일은 ${THEME_MAX_BYTES / 1024}KB 이하만 가져올 수 있습니다`);
}

/** Drop malformed entries from persisted settings and keep at most one `enabled` (= activeThemeId). */
export function normalizeThemeState(themes: unknown, activeThemeId: unknown): ThemeState {
  const seen = new Set<string>();
  const list: CustomTheme[] = [];
  for (const t of Array.isArray(themes) ? themes : []) {
    if (!t || typeof t !== "object") continue;
    const { id, name } = t as Record<string, unknown>;
    if (!isValidThemeId(id) || seen.has(id)) continue;
    seen.add(id);
    list.push({ id, name: typeof name === "string" && name.trim() ? name.trim().slice(0, THEME_NAME_MAX) : id, enabled: false });
  }
  return activateTheme(list, typeof activeThemeId === "string" ? activeThemeId : "");
}

/** Set the active custom theme ("" = none). Unknown ids fall back to none. */
export function activateTheme(themes: CustomTheme[], id: string): ThemeState {
  const active = themes.some((t) => t.id === id) ? id : "";
  return { themes: themes.map((t) => ({ ...t, enabled: t.id === active })), activeThemeId: active };
}

export function addTheme(state: ThemeState, theme: { id: string; name: string }): ThemeState {
  if (!isValidThemeId(theme.id)) throw new Error("잘못된 테마 ID입니다");
  const themes = [...state.themes.filter((t) => t.id !== theme.id), { id: theme.id, name: theme.name, enabled: false }];
  return activateTheme(themes, state.activeThemeId);
}

export function removeTheme(state: ThemeState, id: string): ThemeState {
  return activateTheme(state.themes.filter((t) => t.id !== id), state.activeThemeId === id ? "" : state.activeThemeId);
}

export type SanitizeResult = { css: string; removed: string[] };

/** Decode CSS escapes that spell identifiers/schemes (`\75 rl(`, `\@import`) so the filters below can't be dodged. */
function decodeEscapes(css: string): string {
  const keep = /[A-Za-z0-9@:(/]/;
  // One left-to-right pass so `\\75` stays an escaped backslash + "75". Backslash-newline is a line continuation
  // inside CSS strings (`"http\<LF>s://…"` → "https://…"), so it is dropped.
  return css.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|(\r\n|[\r\n\f])|([\s\S]))/g, (m, hex?: string, nl?: string, ch?: string) => {
    if (nl) return "";
    const c = hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : ch!;
    return keep.test(c) ? c : m;
  });
}

const REMOTE_URL = /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i;
/** Bare strings (image-set("…"), src("…")) only count as remote for URL-ish schemes; `content:"a: b"` stays. */
const REMOTE_STRING = /^(?:(?:https?|ftp|file|javascript|vbscript):|[\\/]{2})/i;
const SAFE_URL = /^data:(?:image|font)\//i;

/**
 * The value the URL parser will actually see: every CSS escape resolved (`ht\9 tps:` → "ht<TAB>tps:") and then
 * tab/newline/space/control chars dropped, as the URL parser strips them. `\` counts as `/` for special schemes.
 */
function urlValue(raw: string): string {
  return raw
    // One left-to-right pass, so `\\e` is an escaped backslash + "e", not a hex escape.
    .replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([\s\S]))/g, (_m, hex?: string, ch?: string) =>
      hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : ch!)
    .replace(/[\s\u0000-\u001f\u007f]/g, "");
}

function isBlockedUrl(raw: string): boolean {
  const v = urlValue(raw);
  if (SAFE_URL.test(v)) return false;
  // Any scheme (http(s):, ftp:, file:, javascript:, …) or protocol-relative `//host` is refused;
  // relative paths resolve against the app's own origin and are fine.
  return REMOTE_URL.test(v);
}

/**
 * Make imported CSS safe to inject: no @import, no remote/script url(...), no `javascript:`,
 * no IE `expression()` / `behavior` / `-moz-binding`. Comments are dropped. Returns what was removed.
 */
export function sanitizeThemeCss(input: string): SanitizeResult {
  const removed: string[] = [];
  const note = (what: string) => {
    if (!removed.includes(what)) removed.push(what);
  };
  let css = String(input ?? "")
    .replace(/^﻿/, "")
    .replace(/\u0000/g, "")
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "");
  css = decodeEscapes(css);

  css = css.replace(/@import\b[^;{}]*(?:;|$)/gi, () => (note("@import"), ""));

  // Strings are escape-aware (`"a\"b"`), so an escaped quote can't end the match early.
  css = css.replace(
    /\burl\(\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|((?:[^()]|\([^()]*\))*?))\s*\)/gi,
    (m, dq?: string, sq?: string, bare?: string) => {
      if (!isBlockedUrl(dq ?? sq ?? bare ?? "")) return m;
      note("url()");
      return "none";
    },
  );
  // image-set("https://…" 1x) and friends take bare strings as URLs.
  css = css.replace(/"((?:[^"\\\n]|\\[\s\S])*)"|'((?:[^'\\\n]|\\[\s\S])*)'/g, (m, dq?: string, sq?: string) => {
    if (!REMOTE_STRING.test(urlValue(dq ?? sq ?? ""))) return m;
    note("url()");
    return '""';
  });

  css = css.replace(/\bexpression\s*\(/gi, () => (note("expression()"), "("));
  css = css.replace(/(?<=^|[;{\s])(?:behavior|-moz-binding)\s*:[^;}]*;?/gi, () => (note("behavior"), ""));
  css = css.replace(/(?:java|vb)script\s*:/gi, () => (note("javascript:"), ""));
  // Can't close the injected <style> even if someone renders it as HTML.
  css = css.replace(/<\/?style/gi, () => (note("</style>"), ""));

  return { css: css.trim(), removed };
}
