/**
 * ubion-media responses for chat files.
 *
 * Chromium's media element always sends `Range: bytes=0-` first. A 206 of the
 * entire buffer is a different path from the 200 thumbnail responses that
 * already play, and Electron's protocol handler has rejected that 206 for
 * `<video>`. A range that covers the whole file is answered as 200. Smaller
 * ranges stay 206 so scrubbing still works once the file is cached.
 *
 * Daou often labels the bytes `application/octet-stream` (or a download type).
 * The container is sniffed, and `ubmExt` (stripped before the upstream fetch)
 * is only a hint for those generic types.
 */

const GENERIC_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
  "application/force-download",
  "application/download",
  "application/x-download",
  "application/unknown",
  "application/x-unknown-content-type",
]);

const EXT_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
  ogg: "video/ogg",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  wmv: "video/x-ms-wmv",
  "3gp": "video/3gpp",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  aac: "audio/aac",
};

/** `mp4`, `clip.MP4`, or a path → `mp4`. Empty when there is no extension. */
export function extensionHint(nameOrExt?: string): string {
  const base = (nameOrExt || "").trim().toLowerCase().split(/[\\/]/).pop() || "";
  const m = /(?:^|\.)([a-z0-9]{1,8})$/.exec(base);
  const ext = m ? m[1] : "";
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

/** Chat-file path the renderer puts on `ubion-media://`. `ubmExt` never reaches Daou. */
export function chatFileMediaPath(cryptId: string, messageId: number, nameOrExt?: string): string {
  const q = new URLSearchParams({ messageId: String(messageId) });
  const ext = extensionHint(nameOrExt);
  if (ext) q.set("ubmExt", ext);
  return `/api/chat/files/${encodeURIComponent(cryptId)}?${q.toString()}`;
}

/** Split a `ubion-media:` request into the Daou path and the renderer-only extension hint. */
export function parseMediaRequest(rawUrl: string): { path: string; ext: string } {
  const u = new URL(rawUrl);
  const ext = extensionHint(u.searchParams.get("ubmExt") || "");
  u.searchParams.delete("ubmExt");
  const path = decodeURIComponent(u.pathname.replace(/^\/+/, "/")) + u.search;
  return { path, ext };
}

export function sniffMediaType(data: Uint8Array, contentType: string, nameOrExt?: string): string {
  const raw = (contentType || "").split(";")[0].trim().toLowerCase();
  const sniffed = sniffContainer(data);
  if (sniffed) return sniffed;
  if (raw === "application/mp4" || raw === "application/x-mp4" || raw === "video/mpeg4" || raw === "video/x-mp4") return "video/mp4";
  if (raw.startsWith("video/") || raw.startsWith("image/") || raw.startsWith("audio/")) return raw;
  if (GENERIC_TYPES.has(raw) && !looksLikeMarkup(data)) {
    const fromExt = EXT_MIME[extensionHint(nameOrExt)];
    if (fromExt) return fromExt;
  }
  return raw || "application/octet-stream";
}

function sniffContainer(data: Uint8Array): string | null {
  if (hasFtyp(data)) return "video/mp4";
  if (data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return "video/webm";
  if (data.length >= 12 && latin1(data, 0, 4) === "RIFF" && latin1(data, 8, 12) === "AVI ") return "video/x-msvideo";
  return null;
}

/** First ISO BMFF box is usually `ftyp`; some files put a short `free`/`wide` box ahead of it. */
function hasFtyp(data: Uint8Array): boolean {
  let off = 0;
  const limit = Math.min(data.length, 256);
  while (off + 8 <= limit) {
    const size = ((data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3]) >>> 0;
    if (latin1(data, off + 4, off + 8) === "ftyp") return true;
    if (size < 8 || off + size > data.length) break;
    off += size;
  }
  return false;
}

/** HTML / JSON error pages must not be labeled video/mp4 from the filename alone. */
function looksLikeMarkup(data: Uint8Array): boolean {
  let i = 0;
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) i = 3;
  const n = Math.min(data.length, 64);
  while (i < n && (data[i] === 0x20 || data[i] === 0x09 || data[i] === 0x0a || data[i] === 0x0d)) i++;
  const c = data[i];
  return c === 0x3c || c === 0x7b || c === 0x5b;
}

function latin1(data: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) out += String.fromCharCode(data[i]);
  return out;
}

/** A Uint8Array whose underlying buffer is exactly `byteLength` (no Node pool tail). */
export function exactBytes(data: Uint8Array): Uint8Array {
  if (data.byteOffset === 0 && data.buffer.byteLength === data.byteLength) return data;
  const out = new Uint8Array(data.byteLength);
  out.set(data);
  return out;
}

export type MediaBody = { status: number; headers: Record<string, string>; body: Uint8Array };

/** `rangeHeader` is the raw Range value, e.g. "bytes=0-1023". */
export function buildMediaResponse(data: Uint8Array, contentType: string, rangeHeader: string | null, nameOrExt?: string): MediaBody {
  const type = sniffMediaType(data, contentType, nameOrExt);
  const size = data.length;
  const headers: Record<string, string> = {
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=86400",
  };
  const full = (): MediaBody => ({
    status: 200,
    headers: { ...headers, "content-length": String(size) },
    body: exactBytes(data),
  });
  const unsatisfiable = (): MediaBody => ({
    status: 416,
    headers: { ...headers, "content-range": `bytes */${size}` },
    body: new Uint8Array(),
  });
  if (!rangeHeader || !rangeHeader.trim()) return full();
  const range = parseByteRange(rangeHeader, size);
  if (!range) return unsatisfiable();
  const { start, end } = range;
  if (start === 0 && end === size - 1) return full();
  const body = exactBytes(data.subarray(start, end + 1));
  return {
    status: 206,
    headers: {
      ...headers,
      "content-length": String(body.byteLength),
      "content-range": `bytes ${start}-${end}/${size}`,
    },
    body,
  };
}

function parseByteRange(rangeHeader: string, size: number): { start: number; end: number } | null {
  if (size === 0) return null;
  const first = rangeHeader.split(",")[0]?.trim() || "";
  const match = /^bytes=(\d*)-(\d*)$/i.exec(first);
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  }
  if (start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}
