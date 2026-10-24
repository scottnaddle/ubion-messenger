/**
 * HTTP transport for DaouClient outside Electron.
 * Native (iOS/Android): CapacitorHttp — no CORS, manual redirects, raw Set-Cookie visible to our CookieJar.
 * Web: globalThis.fetch (CORS applies; only useful against a local mock during development).
 * Never logs URLs with query strings, headers, bodies or cookies.
 */
import { Capacitor, CapacitorHttp, type HttpOptions } from "@capacitor/core";
import type { FetchLike } from "../../electron/core/daou-client";

export type HttpFetch = FetchLike;
export type HttpInit = Parameters<FetchLike>[1];
export type HttpResult = Awaited<ReturnType<FetchLike>>;

/** Subset of CapacitorHttp used here (injectable for tests). */
export type NativeHttp = { request(o: HttpOptions): Promise<{ status: number; headers: Record<string, unknown>; data: unknown }> };

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Split a Set-Cookie header value that the native layer may have comma-joined
 * ("a=1; Path=/, b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT"). A comma only starts a new cookie
 * when it is followed by `name=`; the comma inside an Expires date is not.
 */
export function splitSetCookie(value: string): string[] {
  return value
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** All Set-Cookie values from a native header map (string, comma-joined string, or array; any key case). */
export function setCookieList(headers: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() !== "set-cookie" || v == null) continue;
    for (const item of Array.isArray(v) ? v : [v]) out.push(...splitSetCookie(String(item)));
  }
  return out;
}

/** Case-insensitive single header lookup (arrays joined with ", " like fetch does). */
export function headerValue(headers: Record<string, unknown> | null | undefined, name: string): string | null {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() !== want || v == null) continue;
    return Array.isArray(v) ? v.map(String).join(", ") : String(v);
  }
  return null;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** CapacitorHttp `data` (base64 string for arraybuffer on native, or ArrayBuffer/object/text) → bytes. */
export function responseBytes(data: unknown, base64: boolean): Uint8Array {
  if (data == null) return new Uint8Array(0);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === "string") {
    if (base64) {
      try {
        return base64ToBytes(data);
      } catch {
        /* not base64 after all: treat as text */
      }
    }
    return new TextEncoder().encode(data);
  }
  return new TextEncoder().encode(JSON.stringify(data));
}

/** Request body for CapacitorHttp: native bridges only carry strings, so bytes must be valid UTF-8 text. */
export function bodyToString(body: Uint8Array | string | undefined): string | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("모바일 앱에서는 아직 바이너리 전송(파일 업로드)을 지원하지 않습니다");
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : (bytes.slice().buffer as ArrayBuffer);
}

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new Error("request aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** fetch-shaped adapter over CapacitorHttp.request (redirects disabled; bytes via base64). */
export function createNativeFetch(http: NativeHttp = CapacitorHttp): HttpFetch {
  return async (url, init) => {
    const data = bodyToString(init.body);
    const res = await abortable(
      http.request({
        url,
        method: init.method || "GET",
        headers: init.headers,
        ...(data !== undefined ? { data } : {}),
        responseType: "arraybuffer",
        disableRedirects: true,
        connectTimeout: DEFAULT_TIMEOUT_MS,
        readTimeout: DEFAULT_TIMEOUT_MS,
      }),
      init.signal,
    );
    const headers = res.headers || {};
    const bytes = responseBytes(res.data, true);
    return {
      status: res.status,
      headers: {
        get: (n: string) => headerValue(headers, n),
        getSetCookie: () => setCookieList(headers),
      },
      arrayBuffer: async () => toArrayBuffer(bytes),
    };
  };
}

/** Browser fetch (dev only; the server's CORS policy decides whether it works). */
export function createWebFetch(): HttpFetch {
  return (url, init) => globalThis.fetch(url, init as RequestInit);
}

/** Adapt HttpFetch (CapacitorHttp) to a globalThis.fetch-compatible function for browser-shaped callers. */
export function asBrowserFetch(http: HttpFetch): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h instanceof Headers) h.forEach((v, k) => { headers[k] = v; });
    else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
    else if (h) for (const [k, v] of Object.entries(h)) if (v != null) headers[k] = String(v);
    const body = init?.body == null ? undefined
      : typeof init.body === "string" || init.body instanceof Uint8Array ? init.body
      : init.body instanceof ArrayBuffer ? new Uint8Array(init.body)
      : String(init.body);
    const res = await http(url, {
      method: (init?.method || "GET").toUpperCase(),
      headers,
      body: body as string | Uint8Array | undefined,
      redirect: "manual",
      signal: init?.signal ?? undefined,
    });
    const buf = await res.arrayBuffer();
    const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
    return new Response(nullBody ? null : buf, { status: res.status });
  }) as typeof globalThis.fetch;
}

/** Native CapacitorHttp on iOS/Android, plain fetch on the web. */
export function platformFetch(): HttpFetch {
  return Capacitor.isNativePlatform() ? createNativeFetch() : createWebFetch();
}
