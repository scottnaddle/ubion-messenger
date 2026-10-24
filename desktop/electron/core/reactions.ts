/**
 * 이모지 리액션: our own server (bot.ubion.global) keyed by roomSeq:messageId. On by default in 1.0.22;
 * set UBM_REACTIONS=0 to hide the feature. UBION users only — original-app users cannot see these.
 *
 * ⚠ UNVERIFIED request shape:
 *   GET  {base}/v1/reactions?roomSeq=123&ids=1,2,3  → 200 { reactions: { [messageId]: { [emoji]: number[] } } }
 *   POST {base}/v1/reactions  body { roomSeq, messageId, emoji }  → toggles the caller's reaction
 *        → 200 { ok, added, messageId, reactions: { [emoji]: number[] } } (one message's emoji map)
 * Auth headers: X-UBM-User-Seq (caller seq) + X-UBM-Session (ubt1 server token, never a Daou cookie).
 * X-UBM-Tenant is sent only when getTenantHost returns a host. UBION omits it.
 * Headers are never logged.
 */

import { checkForwardTarget } from "./forward";
import { resolveTenantHeader, ubmRequestHeaders } from "./tenant";

export const REACTIONS_ENV = "UBM_REACTIONS";
export const REACTIONS_DISABLED_TEXT = "이모지 리액션은 아직 지원되지 않습니다";
export const REACTION_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🎉", "🔥"] as const;
/** UTF-16 code units, not code points: large ZWJ sequences are rejected instead of silently truncated. */
export const REACTION_MAX_EMOJI_LENGTH = 16;
const EMOJI_SEQUENCE_RE =
  /^(?:\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})*(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})*)*|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)$/u;
const MAX_SESSION_LENGTH = 4096;

export type ReactionsCaps = { enabled: boolean };
/** messageId (string) → emoji → userSeqs that reacted. */
export type ReactionMap = Record<string, Record<string, number[]>>;

export type ReactionsOptions = {
  baseUrl?: string;
  getUserSeq: () => number;
  getSessionHeader: () => Promise<string>;
  /** Daou server host for a future multi-tenant bot. Empty omits X-UBM-Tenant. */
  getTenantHost?: () => string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export type ReactionsResult<T = ReactionMap> = { ok: true; data: T } | { ok: false; message: string };

/** 403 from /v1/reactions: the bot is not in this room (membership check), not a transient failure. */
export const REACTION_ROOM_FORBIDDEN = "봇이 참여하지 않은 대화방입니다.";

export function reactionsEnabled(env: Record<string, string | undefined> | undefined): boolean {
  return env?.[REACTIONS_ENV] !== "0";
}

export function reactionsCaps(env: Record<string, string | undefined> | undefined): ReactionsCaps {
  return { enabled: reactionsEnabled(env) };
}

function positiveSeq(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label}가 올바르지 않습니다`);
  return n;
}

export function normalizeRoomSeq(value: unknown): number {
  return positiveSeq(value, "대화방");
}

export function normalizeMessageId(value: unknown): number {
  return positiveSeq(value, "메시지");
}

export function normalizeMessageIds(value: unknown): number[] {
  const list = Array.isArray(value) ? value : [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of list) {
    const n = positiveSeq(v, "메시지");
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function normalizeEmoji(value: unknown): string {
  if (typeof value !== "string") throw new Error("이모지를 선택하세요");
  const emoji = value.trim();
  if (!emoji || emoji.length > REACTION_MAX_EMOJI_LENGTH || !EMOJI_SEQUENCE_RE.test(emoji)) {
    throw new Error("이모지를 선택하세요");
  }
  return emoji;
}

/** Coerce one message's `{ [emoji]: userSeq[] }` map (GET entries and POST `reactions`). */
function parseEmojiMap(value: unknown): Record<string, number[]> {
  const emojiMap: Record<string, number[]> = {};
  if (!value || typeof value !== "object") return emojiMap;
  for (const [emoji, seqs] of Object.entries(value as Record<string, unknown>)) {
    const list = Array.isArray(seqs)
      ? seqs.map((s) => Number(s)).filter((n) => Number.isSafeInteger(n) && n > 0)
      : [];
    if (list.length) emojiMap[emoji] = list;
  }
  return emojiMap;
}

/** Parse/coerce the documented GET response into ReactionMap (messageId → emoji → userSeqs). */
export function parseReactions(body: unknown): ReactionMap {
  const out: ReactionMap = {};
  if (!body || typeof body !== "object") return out;
  const reactions = (body as Record<string, unknown>).reactions;
  if (!reactions || typeof reactions !== "object") return out;
  for (const [messageId, byEmoji] of Object.entries(reactions as Record<string, unknown>)) {
    const emojiMap = parseEmojiMap(byEmoji);
    if (Object.keys(emojiMap).length) out[messageId] = emojiMap;
  }
  return out;
}

/**
 * Parse the POST response. Its `reactions` is ONE message's emoji map, not keyed by messageId, so wrap it
 * with the messageId we sent. An empty map is kept as an empty entry so callers can reconcile a removal.
 */
export function parseReactionToggle(body: unknown, messageId: number): ReactionMap {
  const key = String(messageId);
  if (!body || typeof body !== "object") return { [key]: {} };
  return { [key]: parseEmojiMap((body as Record<string, unknown>).reactions) };
}

export function reactionUserSeqs(map: ReactionMap, messageId: unknown, emoji: string): number[] {
  if (messageId == null) return [];
  const seqs = map[String(messageId)]?.[emoji];
  return Array.isArray(seqs) ? seqs : [];
}

/** Self-only guard for the reaction toggle — reuses the shared forward/notice guard. */
export function guardReactionRoom({ selfOnly, roomSeq, me, selfRoomSeq }: {
  selfOnly: boolean; roomSeq: number; me: number; selfRoomSeq?: number | null;
}): void {
  checkForwardTarget({ selfOnly, target: { roomSeq }, me, selfRoomSeq });
}

export function createReactionsClient({
  baseUrl = "https://bot.ubion.global",
  getUserSeq,
  getSessionHeader,
  getTenantHost,
  fetch: fetchImpl,
  timeoutMs = 8000,
}: ReactionsOptions) {
  const root = String(baseUrl).replace(/\/+$/, "");

  async function request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    parse: (data: unknown) => ReactionMap = parseReactions,
  ): Promise<ReactionsResult> {
    const userSeq = getUserSeq();
    if (!Number.isSafeInteger(userSeq) || userSeq <= 0) return { ok: false, message: "로그인이 필요합니다" };
    let session: string;
    try {
      session = await getSessionHeader();
    } catch {
      return { ok: false, message: "세션이 만료되었습니다. 다시 로그인하세요." };
    }
    if (typeof session !== "string" || session.length > MAX_SESSION_LENGTH || /[\r\n]/.test(session)) {
      return { ok: false, message: "세션이 만료되었습니다. 다시 로그인하세요." };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      const doFetch = fetchImpl ?? globalThis.fetch;
      res = await doFetch(`${root}${path}`, {
        method,
        headers: ubmRequestHeaders(userSeq, session, resolveTenantHeader(getTenantHost)),
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      return { ok: false, message: "리액션 서버에 연결할 수 없습니다." };
    } finally {
      clearTimeout(timer);
    }

    let text = "";
    try {
      text = await res.text();
    } catch {
      return { ok: false, message: "리액션 서버에 연결할 수 없습니다." };
    }
    if (res.status === 401) return { ok: false, message: "세션이 만료되었습니다. 다시 로그인하세요." };
    if (res.status === 403) return { ok: false, message: REACTION_ROOM_FORBIDDEN };
    if (res.status < 200 || res.status >= 300) return { ok: false, message: "리액션 서버에서 처리하지 못했습니다." };

    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { ok: true, data: parse(data) };
  }

  return {
    list: (roomSeq: number, messageIds: number[]): Promise<ReactionsResult> => {
      const ids = normalizeMessageIds(messageIds);
      const query = `roomSeq=${encodeURIComponent(String(roomSeq))}&ids=${encodeURIComponent(ids.join(","))}`;
      return request("GET", `/v1/reactions?${query}`);
    },
    toggle: (roomSeq: number, messageId: number, emoji: string): Promise<ReactionsResult> =>
      request("POST", "/v1/reactions", { roomSeq, messageId, emoji },
        (data) => parseReactionToggle(data, messageId)),
  };
}

/** Strip anything token- or code-like from a diagnostic line before it is written to disk. */
export function redactDiag(line: string): string {
  return String(line)
    .replace(/ubt1\.[A-Za-z0-9._-]+/g, "ubt1.***")
    .replace(/\[\[ubm:auth:[^\]]*\]\]/g, "[[ubm:auth:***]]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "***")
    .slice(0, 500);
}
