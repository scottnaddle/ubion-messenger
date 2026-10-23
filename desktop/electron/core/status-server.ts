/**
 * 상태 메시지 server fallback: a small client for our own server (bot.ubion.global) so UBION users
 * can see each other's status without relying on the XMPP relay. Behind UBM_STATUS_SERVER=1.
 *
 * ⚠ Request shape is UNVERIFIED (no live calls made). Documented as:
 *   GET  {base}/v1/status/{userSeq}                 → 200 { "text": string }
 *   PUT  {base}/v1/status/{userSeq}  body {text}    → 200 { "text": string }
 * Authenticated by a UBION server token (X-UBM-Session, supplied by the caller — never DaouOffice cookies); the token is
 * never logged. A malformed/absent `text` is normalized to "".
 */

export type StatusServerOptions = {
  baseUrl?: string;
  getSessionHeader: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export type StatusResult =
  | { ok: true; text: string }
  | { ok: false; message: string };

const MAX_COOKIE_LENGTH = 4096;

export function createStatusClient({
  baseUrl = "https://bot.ubion.global",
  getSessionHeader,
  fetch: fetchImpl,
  timeoutMs = 8000,
}: StatusServerOptions) {
  const root = String(baseUrl).replace(/\/+$/, "");

  async function request(method: "GET" | "PUT", userSeq: number, text?: string): Promise<StatusResult> {
    let cookie: string;
    try {
      cookie = await getSessionHeader();
    } catch {
      return { ok: false, message: "세션이 만료되었습니다. 다시 로그인하세요." };
    }
    if (typeof cookie !== "string" || cookie.length > MAX_COOKIE_LENGTH || /[\r\n]/.test(cookie)) {
      return { ok: false, message: "세션이 만료되었습니다. 다시 로그인하세요." };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      const doFetch = fetchImpl ?? globalThis.fetch;
      res = await doFetch(`${root}/v1/status/${encodeURIComponent(String(userSeq))}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-UBM-User-Seq": String(userSeq),
          "X-UBM-Session": cookie,
        },
        body: method === "PUT" ? JSON.stringify({ text: text ?? "" }) : undefined,
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      return { ok: false, message: "상태 메시지 서버에 연결할 수 없습니다." };
    } finally {
      clearTimeout(timer);
    }

    let body = "";
    try {
      body = await res.text();
    } catch {
      return { ok: false, message: "상태 메시지 서버에 연결할 수 없습니다." };
    }
    if (res.status === 401) return { ok: false, message: "세션이 만료되었습니다. 다시 로그인하세요." };
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, message: "상태 메시지 서버에서 처리하지 못했습니다." };
    }

    let data: any = null;
    try {
      data = body ? JSON.parse(body) : null;
    } catch {
      data = null;
    }
    if (!data || typeof data !== "object") return { ok: false, message: "상태 메시지 서버 응답을 확인할 수 없습니다." };
    const storedText = typeof data.text === "string" ? data.text : typeof data.status?.text === "string" ? data.status.text : "";
    return { ok: true, text: storedText };
  }

  return {
    get: (userSeq: number): Promise<StatusResult> => request("GET", userSeq),
    put: (userSeq: number, text: string): Promise<StatusResult> => request("PUT", userSeq, text),
  };
}
