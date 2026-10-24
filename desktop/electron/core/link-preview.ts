import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";

/** OpenGraph link preview, fetched in the main process. No cookies are ever sent. */
import { flavorProfile } from "./flavor";
import type { LinkPreview } from "./types";
export type { LinkPreview };

export const PREVIEW_TIMEOUT_MS = 5000;
export const PREVIEW_MAX_BYTES = 1024 * 1024;

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s.startsWith("::ffff:")) return isPrivateIp(s.slice(7));
    return s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb");
  }
  return true;
}

export function isCompanyHost(host: string, companyBase?: string): boolean {
  if (!companyBase) return false;
  try {
    return new URL(companyBase).hostname.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? "") : undefined;
}

export function parseOpenGraph(html: string, pageUrl: string): LinkPreview {
  const head = html.slice(0, 300_000);
  const meta: Record<string, string> = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(m[0], "property") || attr(m[0], "name") || "").toLowerCase();
    const content = attr(m[0], "content");
    if (key && content != null && !(key in meta)) meta[key] = content.trim();
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const clip = (s: string | undefined, n: number) => (s ? (s.length > n ? s.slice(0, n - 1) + "…" : s) : undefined);
  let image: string | undefined = meta["og:image"] || meta["og:image:url"] || meta["twitter:image"];
  if (image) {
    try {
      const u = new URL(image, pageUrl);
      image = /^https?:$/.test(u.protocol) ? u.toString() : undefined;
    } catch {
      image = undefined;
    }
  }
  let host = "";
  try { host = new URL(pageUrl).hostname; } catch { /* */ }
  return {
    url: pageUrl,
    title: clip(meta["og:title"] || meta["twitter:title"] || (titleTag ? decode(titleTag.trim()) : undefined), 200),
    description: clip(meta["og:description"] || meta["twitter:description"] || meta["description"], 300),
    siteName: clip(meta["og:site_name"] || host, 80),
    image,
  };
}

export type FetchOpts = { companyBase?: string; timeoutMs?: number; maxBytes?: number; lookup?: (h: string) => Promise<string[]>; /** tests only */ allowPrivate?: boolean };

async function resolveAll(host: string, opts: FetchOpts): Promise<string[]> {
  if (net.isIP(host)) return [host];
  if (opts.lookup) return opts.lookup(host);
  return (await dns.lookup(host, { all: true })).map((r) => r.address);
}

/** Validate scheme + host. Throws on blocked targets. Returns the pinned IP to connect to. */
export async function checkTarget(raw: string, opts: FetchOpts = {}): Promise<{ url: URL; ip: string }> {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("blocked scheme");
  if (url.username || url.password) throw new Error("blocked credentials in url");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.local$|\.internal$|\.lan$/i.test(host) && !isCompanyHost(host, opts.companyBase)) throw new Error("blocked host");
  const ips = await resolveAll(host, opts);
  if (!ips.length) throw new Error("dns");
  if (!opts.allowPrivate && !isCompanyHost(host, opts.companyBase) && ips.some(isPrivateIp)) throw new Error("blocked private address");
  return { url, ip: ips[0] };
}

function getOnce(url: URL, ip: string, opts: FetchOpts, accept = /text\/html|application\/xhtml/i): Promise<{ status: number; location?: string; type: string; body: string; raw?: Buffer; truncated?: boolean }> {
  const timeoutMs = opts.timeoutMs ?? PREVIEW_TIMEOUT_MS;
  const max = opts.maxBytes ?? PREVIEW_MAX_BYTES;
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: "GET",
        // pin the validated IP (prevents DNS rebinding between check and connect)
        lookup: (_h: string, o: any, cb: any) => (o && o.all ? cb(null, [{ address: ip, family: net.isIPv6(ip) ? 6 : 4 }]) : cb(null, ip, net.isIPv6(ip) ? 6 : 4)),
        headers: { "user-agent": `Mozilla/5.0 (${flavorProfile().productName} link preview)`, accept: "text/html,application/xhtml+xml", "accept-language": "ko,en;q=0.8" },
        timeout: timeoutMs,
      } as any,
      (res) => {
        const status = res.statusCode || 0;
        const type = String(res.headers["content-type"] || "");
        if (status >= 300 && status < 400) { res.resume(); return resolve({ status, location: res.headers.location, type, body: "" }); }
        if (status !== 200 || !accept.test(type)) { res.resume(); return resolve({ status, type, body: "" }); }
        const chunks: Buffer[] = []; let n = 0; let truncated = false;
        res.on("data", (c: Buffer) => {
          n += c.length;
          if (n > max) { truncated = true; chunks.push(c.subarray(0, c.length - (n - max))); res.destroy(); finish(); return; }
          chunks.push(c);
        });
        let done = false;
        const finish = () => { if (done) return; done = true; const raw = Buffer.concat(chunks); resolve({ status, type, raw, truncated, body: /^image\//i.test(type) ? "img" : decodeBody(raw, type) }); };
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
      }
    );
    const timer = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.on("close", () => clearTimeout(timer));
    req.end();
  });
}

function decodeBody(buf: Buffer, type: string): string {
  const cs = (/charset=([\w-]+)/i.exec(type)?.[1] || /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString("latin1"))?.[1] || "utf-8").toLowerCase();
  try {
    return new TextDecoder(cs === "ks_c_5601-1987" ? "euc-kr" : cs).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

export async function fetchLinkPreview(raw: string, opts: FetchOpts = {}): Promise<LinkPreview | null> {
  let current = raw;
  for (let hop = 0; hop < 4; hop++) {
    const { url, ip } = await checkTarget(current, opts);
    if (isCompanyHost(url.hostname, opts.companyBase)) return internalPreview(url.toString());
    const r = await getOnce(url, ip, opts);
    if (r.location) { current = new URL(r.location, url).toString(); continue; }
    if (!r.body) return null;
    const p = parseOpenGraph(r.body, url.toString());
    return p.title || p.description ? p : null;
  }
  return null;
}

/** Company (coco) URLs are never fetched: just a simple card. */
export function internalPreview(url: string): LinkPreview {
  let host = url;
  try { host = new URL(url).hostname; } catch { /* */ }
  return { url, title: "DaouOffice", description: url.replace(/^https?:\/\//, ""), siteName: host, internal: true };
}

/** Tiny TTL+LRU cache that also dedupes in-flight requests. */
export class PreviewCache {
  private map = new Map<string, { at: number; v: Promise<LinkPreview | null> }>();
  constructor(private max = 300, private ttlMs = 6 * 3600_000, private failTtlMs = 10 * 60_000) {}
  get(url: string, load: () => Promise<LinkPreview | null>, now = Date.now()): Promise<LinkPreview | null> {
    const hit = this.map.get(url);
    if (hit && now - hit.at < this.ttlMs) {
      this.map.delete(url); this.map.set(url, hit);
      return hit.v;
    }
    const v = load().catch(() => null);
    const entry = { at: now, v };
    this.map.set(url, entry);
    v.then((r) => { if (!r) entry.at = now - this.ttlMs + this.failTtlMs; });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return v;
  }
  get size() { return this.map.size; }
}

/** og:image proxied through main (no cookies, same SSRF rules, 1MB cap) → data: URL for the renderer. */
export async function fetchPreviewImage(raw: string, opts: FetchOpts = {}): Promise<string | null> {
  let current = raw;
  for (let hop = 0; hop < 4; hop++) {
    const { url, ip } = await checkTarget(current, opts);
    if (isCompanyHost(url.hostname, opts.companyBase)) return null;
    const r = await getOnce(url, ip, opts, /^image\/(png|jpe?g|gif|webp|avif|bmp)/i);
    if (r.location) { current = new URL(r.location, url).toString(); continue; }
    if (!r.raw || r.truncated) return null;
    return `data:${r.type.split(";")[0]};base64,${r.raw.toString("base64")}`;
  }
  return null;
}
