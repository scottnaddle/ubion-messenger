/**
 * Authenticated avatar/thumbnail URLs for Capacitor (no ubion-media:// protocol).
 * Fetches via DaouClient.fetchBinary → blob:/data: URLs; initials remain the Avatar fallback.
 * Paths and cookies are never logged.
 */
import type { DaouClient } from "../../electron/core/daou-client";

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

function toObjectUrl(data: Buffer | Uint8Array, contentType: string): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: contentType || "image/jpeg" });
  return URL.createObjectURL(blob);
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
  const path = normalizePath(src);
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
      const url = toObjectUrl(data, contentType);
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
  return cache.get(normalizePath(src)) || "";
}

export function clearMediaCache() {
  for (const u of cache.values()) {
    if (u.startsWith("blob:")) URL.revokeObjectURL(u);
  }
  cache.clear();
  inflight.clear();
}
