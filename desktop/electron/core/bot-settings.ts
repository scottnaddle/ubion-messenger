/**
 * UBION bot per-room autonomy settings.
 * Talks to bot.ubion.global with the DaouOffice session cookies supplied by the caller.
 * Cookies are only ever sent in the X-Daou-Session header; they are never logged or included in errors.
 */

export type BotSettingsState = {
  roomId: string;
  autonomy: boolean;
  updatedBy?: string;
  updatedAt?: string;
};

export type BotSettingsErrorKind = "auth" | "forbidden" | "rate_limited" | "unavailable" | "network" | "bad_response";

export type BotSettingsResult =
  | { ok: true; settings: BotSettingsState }
  | { ok: false; kind: BotSettingsErrorKind; message: string; retryAfterS?: number };

export const BOT_ERROR_MESSAGES = {
  auth: "세션이 만료되었습니다. 다시 로그인하세요.",
  forbidden: "이 대화방의 설정을 변경할 권한이 없습니다.",
  rate_limited: "잠시 후 다시 시도하세요.",
  unavailable: "봇 서버에서 이 기능을 사용할 수 없습니다.",
  network: "봇 서버에 연결할 수 없습니다.",
  bad_response: "봇 서버 응답을 확인할 수 없습니다.",
} as const;

export const BOT_MESSAGES = BOT_ERROR_MESSAGES;

export type BotSettingsOptions = {
  baseUrl?: string;
  getCookieHeader: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

const MAX_COOKIE_LENGTH = 4096;

function fail(kind: BotSettingsErrorKind, retryAfterS?: number): BotSettingsResult {
  return retryAfterS != null && Number.isFinite(retryAfterS)
    ? { ok: false, kind, message: BOT_ERROR_MESSAGES[kind], retryAfterS }
    : { ok: false, kind, message: BOT_ERROR_MESSAGES[kind] };
}

function retryAfterFrom(data: any, res: Response): number | undefined {
  const raw = data?.error?.retry_after_s ?? data?.retry_after_s ?? res.headers?.get?.("retry-after");
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function createBotSettingsClient({
  baseUrl = "https://bot.ubion.global",
  getCookieHeader,
  fetch: fetchImpl,
  timeoutMs = 8000,
}: BotSettingsOptions) {
  const root = String(baseUrl).replace(/\/+$/, "");

  async function request(method: "GET" | "PUT", roomId: string, autonomy?: boolean): Promise<BotSettingsResult> {
    try {
      let cookie: string;
      try {
        cookie = await getCookieHeader();
      } catch {
        return fail("auth");
      }
      if (typeof cookie !== "string" || cookie.length > MAX_COOKIE_LENGTH || /[\r\n]/.test(cookie)) {
        return fail("auth");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        const doFetch = fetchImpl ?? globalThis.fetch;
        res = await doFetch(`${root}/bot/rooms/${encodeURIComponent(roomId)}/settings`, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-Daou-Session": cookie,
          },
          body: method === "PUT" ? JSON.stringify({ autonomy: !!autonomy }) : undefined,
          signal: controller.signal,
        });
      } catch {
        return fail("network");
      } finally {
        clearTimeout(timer);
      }

      let text = "";
      try {
        if (typeof res.text === "function") text = await res.text();
        else if (typeof (res as any).json === "function") text = JSON.stringify(await (res as any).json());
      } catch {
        return fail("network");
      }

      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }

      if (res.status === 401) return fail("auth");
      if (res.status === 403) return fail("forbidden");
      if (res.status === 404) return fail("unavailable");
      if (res.status === 429) return fail("rate_limited", retryAfterFrom(data, res));
      if (res.status < 200 || res.status >= 300) {
        return fail(res.status === 400 ? "bad_response" : "unavailable");
      }

      if (!data || typeof data !== "object") return fail("bad_response");
      const source = method === "PUT" ? data.settings : data;
      if (!source || typeof source !== "object" || typeof source.autonomy !== "boolean") {
        return fail("bad_response");
      }

      const room = typeof source.room_id === "string"
        ? source.room_id
        : typeof data.room_id === "string"
          ? data.room_id
          : roomId;
      const settings: BotSettingsState = { roomId: room, autonomy: source.autonomy };
      if (typeof source.updated_by === "string") settings.updatedBy = source.updated_by;
      if (typeof source.updated_at === "string") settings.updatedAt = source.updated_at;
      return { ok: true, settings };
    } catch {
      return fail("network");
    }
  }

  return {
    get: (roomId: string): Promise<BotSettingsResult> => request("GET", String(roomId)),
    set: (roomId: string, autonomy: boolean): Promise<BotSettingsResult> =>
      request("PUT", String(roomId), autonomy),
  };
}
