/**
 * Authenticated avatar/thumbnail URLs for Capacitor (no ubion-media:// protocol).
 * Fetches via DaouClient.fetchBinary → blob:/data: URLs; initials remain the Avatar fallback.
 * Paths and cookies are never logged.
 */
import type { DaouClient } from "../../electron/core/daou-client";
import { extensionHint, sniffMediaType } from "../../electron/core/media-response";

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const MAX = 200;

function normalizePath(p: string): string {
  let path = p;
  try {
    if (/^https?:\/\//.test(p)) {
      const u = new URL(p);
      path = u.pathname + u.search;
    }
  } catch {
    /* keep */
  }
  if (!path.startsWith("/")) path = "/" + path;
  return path;
}

function toObjectUrl(data: Buffer | Uint8Array, contentType: string, nameOrExt?: string): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  // Daou often labels an mp4 application/octet-stream. Sniff so <video> will play the blob.
  const type = sniffMediaType(copy, contentType, nameOrExt) || contentType || "application/octet-stream";
  const blob = new Blob([copy], { type });
  return URL.createObjectURL(blob);
}

/** `ubmExt` is a renderer hint (desktop media protocol). It must not be sent to Daou. */
export function stripMediaHint(src: string): { path: string; ext: string } {
  const path = normalizePath(src);
  try {
    const u = new URL(path, "https://local.invalid");
    const ext = extensionHint(u.searchParams.get("ubmExt") || "");
    u.searchParams.delete("ubmExt");
    return { path: u.pathname + u.search, ext };
  } catch {
    return { path, ext: "" };
  }
}

function remember(path: string, url: string) {
  if (cache.has(path)) {
    const prev = cache.get(path)!;
    if (prev.startsWith("blob:")) URL.revokeObjectURL(prev);
    cache.delete(path);
  }
  cache.set(path, url);
  while (cache.size > MAX) {
    const k = cache.keys().next().value!;
    const u = cache.get(k)!;
    if (u.startsWith("blob:")) URL.revokeObjectURL(u);
    cache.delete(k);
  }
}

/** Resolve a server-relative image path to a blob: URL (cached). Empty string on failure. */
export async function resolveMediaUrl(client: DaouClient | null | undefined, src: string | null | undefined): Promise<string> {
  if (!src || !client?.user) return "";
  if (src.startsWith("data:") || src.startsWith("blob:")) return src;
  const hinted = stripMediaHint(src);
  const path = hinted.path;
  const hit = cache.get(path);
  if (hit) return hit;
  const pending = inflight.get(path);
  if (pending) return pending;
  const job = (async () => {
    try {
      let p = path;
      if (p.startsWith("/api/chat/files/") && !/[?&]userSeq=/.test(p) && client.user)
        p += (p.includes("?") ? "&" : "?") + `userSeq=${client.user.id}`;
      const { data, contentType } = await client.fetchBinary(p);
      const url = toObjectUrl(data, contentType, hinted.ext);
      remember(path, url);
      return url;
    } catch {
      return "";
    } finally {
      inflight.delete(path);
    }
  })();
  inflight.set(path, job);
  return job;
}

export function peekMediaUrl(src: string | null | undefined): string {
  if (!src) return "";
  if (src.startsWith("data:") || src.startsWith("blob:")) return src;
  return cache.get(stripMediaHint(src).path) || "";
}

export function clearMediaCache() {
  for (const u of cache.values()) {
    if (u.startsWith("blob:")) URL.revokeObjectURL(u);
  }
  cache.clear();
  inflight.clear();
}
