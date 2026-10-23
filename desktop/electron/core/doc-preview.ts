import { extOf } from "./attach";

/**
 * 문서 미리보기 (plan §9).
 * Official client: handlePreviewClick → Kc("fileViewer", cryptId) → a <webview> on the server doc viewer.
 * The viewer URL builder was not found in the bundle, so the server path is behind a template:
 *   UBM_DOC_VIEWER_URL="{server}/some/viewer?cryptId={cryptId}&userSeq={userSeq}"
 * Unset → DOC_VIEWER_SERVER is off and we always use the local fallback
 * (download → in-app window for pdf/images/txt, else the OS default app). main.ts holds the DOC_VIEWER_SERVER flag.
 */
export const DOC_VIEWER_ENV = "UBM_DOC_VIEWER_URL";

export const IMAGE_PREVIEW_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "bmp", "webp"] as const;
export const PREVIEW_EXTENSIONS = [
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "hwp", "txt", ...IMAGE_PREVIEW_EXTENSIONS,
] as const;
/** Chromium can render these itself (native PDF viewer, <img>, plain text). */
export const LOCAL_INAPP_EXTENSIONS = ["pdf", "txt", ...IMAGE_PREVIEW_EXTENSIONS] as const;

export function isPreviewExtension(name?: string, ext?: string): boolean {
  return (PREVIEW_EXTENSIONS as readonly string[]).includes(extOf(name, ext));
}

export function isLocalInAppExtension(name?: string, ext?: string): boolean {
  return (LOCAL_INAPP_EXTENSIONS as readonly string[]).includes(extOf(name, ext));
}

/** Trimmed template or "" when unset/blank. */
export function docViewerTemplate(env: Record<string, string | undefined> = {}): string {
  return String(env[DOC_VIEWER_ENV] ?? "").trim();
}

/** Feature flag: the server doc viewer is only used when a template is configured. */
export function docViewerServerEnabled(env: Record<string, string | undefined> = {}): boolean {
  return docViewerTemplate(env) !== "";
}

/**
 * Fill the template. {server} is the server origin (no trailing slash); {cryptId}/{userSeq} are URL-encoded.
 * Returns null when no template, missing cryptId, or the result is not an http(s) URL on the server host
 * (the viewer window carries the SSO cookies, so it must never load another origin).
 */
export function buildPreviewUrl(serverUrl: string, cryptId: string, userSeq: number | string | undefined, template: string): string | null {
  const t = String(template || "").trim();
  if (!t || !cryptId || !serverUrl) return null;
  const server = String(serverUrl).replace(/\/+$/, "");
  const url = t
    .replace(/\{server\}/g, server)
    .replace(/\{cryptId\}/g, encodeURIComponent(cryptId))
    .replace(/\{userSeq\}/g, encodeURIComponent(userSeq == null ? "" : String(userSeq)));
  return isServerUrl(url, server) ? url : null;
}

/** Same rule as portal-cookies isPortalUrl (kept local so this module stays renderer-safe). */
function isServerUrl(url: string, baseUrl: string): boolean {
  try {
    const u = new URL(url), b = new URL(baseUrl);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname === b.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

export type PreviewMode = "server" | "inapp" | "external";

/** Which preview path to take for a file. */
export function planPreview(name: string | undefined, ext: string | undefined, serverEnabled: boolean): PreviewMode {
  if (serverEnabled && isPreviewExtension(name, ext)) return "server";
  return isLocalInAppExtension(name, ext) ? "inapp" : "external";
}

/** Safe temp file name: no path separators / control or reserved chars; ends in the planned extension. */
export function previewTempName(name: string | undefined, messageId: number | undefined, ext?: string): string {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  let clean = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^\.+/, "").trim().slice(0, 120);
  // Same precedence as planPreview (explicit ext first), so the file on disk is the type that was planned
  // (name "a.html" + ext "pdf" → "a.html.pdf", never an .html page). Only plain extensions are used.
  const planned = extOf(clean, ext);
  const e = /^[a-z0-9]{1,8}$/.test(planned) ? planned : extOf(clean, undefined);
  if (!clean) clean = e ? `file.${e}` : "file";
  else if (e && !clean.toLowerCase().endsWith(`.${e}`)) clean = `${clean}.${e}`;
  return `${messageId != null && Number.isFinite(Number(messageId)) ? Number(messageId) : "x"}-${clean}`;
}
