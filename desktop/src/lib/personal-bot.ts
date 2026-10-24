/**
 * 내 봇 (1.1). Always the local PersonalBotChat session `ubm.personal-bot.v1:*`.
 * It does not open the 유비온봇 DM or the 나 room. Those stay the company bot channel
 * for group autonomy and /요약.
 *
 * Live replies go to Scott's Mac mini proxy. The desktop never holds a MiniMax key.
 *   POST http://127.0.0.1:8787/v1/personal-bot/chat
 *   body: { userId, messages: [{ role: "user" | "assistant", content }] }
 *   200: { reply }
 * The proxy prepends PERSONAL_BOT_SYSTEM_PROMPT and calls MiniMax-M3.1-Flash.
 * Override the URL with VITE_UBM_PERSONAL_BOT_URL.
 * VITE_UBM_PERSONAL_BOT_STUB=1 or VITE_UBM_ROOM_AI_STUB=1 forces the offline stub.
 * A network or 5xx failure is shown in the chat. It does not silently switch to the stub.
 */

export const UBM_PERSONAL_BOT_URL = "http://127.0.0.1:8787/v1/personal-bot/chat";
export const PERSONAL_BOT_STORAGE_PREFIX = "ubm.personal-bot.v1:";
export const PERSONAL_BOT_TURN_LIMIT = 40;
export const PERSONAL_BOT_WIRE_LIMIT = 24;
export const PERSONAL_BOT_LIVE_ERROR = "내 봇 서버에 연결하지 못했습니다.";
export const PERSONAL_BOT_SERVER_ERROR = "내 봇 서버가 응답하지 못했습니다.";
export const PERSONAL_BOT_LIVE_BAD = "내 봇 응답을 확인하지 못했습니다.";

/** Proxy-owned system prompt. The desktop does not send this on the wire. */
export const PERSONAL_BOT_SYSTEM_PROMPT = [
  "당신은 유비온 메신저의 개인 비서입니다. 한국어로 대화하듯 답합니다.",
  "메일, 전자결재, 일정은 아직 연결되어 있지 않습니다. 그 기능을 물으면 아직 연결 전이라고 짧게 말하고, 이어서 지금 도울 수 있는 범위를 안내합니다.",
  "사용자의 문장을 되풀이하거나 \"메모해 두었습니다\"라고만 답하지 마세요.",
].join("\n");

export const PERSONAL_BOT_GREETING = "안녕하세요. 저는 유비온 비서입니다. 메일·결재·일정은 아직 연결 전이고, 그 외에는 편하게 말씀해 주세요.";

export type PersonalBotRoom = {
  key: string;
  kind?: string | null;
  name?: string | null;
  isSelf?: boolean;
  peerUserId?: number;
};

export type PersonalBotTarget = { kind: "local" };

export type PersonalBotTurn = {
  id: string;
  role: "user" | "bot";
  text: string;
  createdAt?: string;
};

export type PersonalBotWireMessage = {
  role: "user" | "assistant";
  content: string;
};

export type PersonalBotEnv = {
  VITE_UBM_PERSONAL_BOT_URL?: string;
  VITE_UBM_PERSONAL_BOT_STUB?: string;
  VITE_UBM_ROOM_AI_STUB?: string;
  VITEST?: boolean | string;
};

export type PersonalBotStorage = Pick<Storage, "getItem" | "setItem">;

export type PersonalBotReplyInput = {
  userId: number;
  messages: readonly PersonalBotWireMessage[];
  signal?: AbortSignal;
};

export type PersonalBotClient = {
  mode: "live" | "stub";
  reply(input: PersonalBotReplyInput): Promise<string>;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function resolvePersonalBot(
  _rooms?: readonly PersonalBotRoom[],
  _botUserSeq?: number,
): PersonalBotTarget {
  return { kind: "local" };
}

/** Null means "use the stub" (explicit stub flag, or the vitest runner). Otherwise the live proxy URL. */
export function resolvePersonalBotUrl(env?: PersonalBotEnv): string | null {
  if (!env) return UBM_PERSONAL_BOT_URL;
  if (
    env.VITE_UBM_PERSONAL_BOT_STUB === "1"
    || env.VITE_UBM_ROOM_AI_STUB === "1"
    || env.VITEST === true
    || env.VITEST === "true"
  ) return null;
  const custom = typeof env.VITE_UBM_PERSONAL_BOT_URL === "string" ? env.VITE_UBM_PERSONAL_BOT_URL.trim() : "";
  return custom || UBM_PERSONAL_BOT_URL;
}

function personalBotEnvFromBuild(): PersonalBotEnv {
  return {
    VITE_UBM_PERSONAL_BOT_URL: import.meta.env.VITE_UBM_PERSONAL_BOT_URL,
    VITE_UBM_PERSONAL_BOT_STUB: import.meta.env.VITE_UBM_PERSONAL_BOT_STUB,
    VITE_UBM_ROOM_AI_STUB: import.meta.env.VITE_UBM_ROOM_AI_STUB,
    VITEST: import.meta.env.VITEST,
  };
}

export function personalBotStorageKey(userId: number): string | null {
  if (!Number.isSafeInteger(userId)) return null;
  return `${PERSONAL_BOT_STORAGE_PREFIX}${userId}`;
}

function greetingTurn(): PersonalBotTurn {
  return { id: "greet", role: "bot", text: PERSONAL_BOT_GREETING };
}

function isStubText(text: string): boolean {
  return text.trim().startsWith("[스텁]");
}

function sanitizeTurns(data: unknown): PersonalBotTurn[] {
  if (!Array.isArray(data)) return [];
  const turns: PersonalBotTurn[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    const role = (item as { role?: unknown }).role;
    const text = (item as { text?: unknown }).text;
    const createdAt = (item as { createdAt?: unknown }).createdAt;
    if (typeof id !== "string" || !id) continue;
    if (role !== "user" && role !== "bot") continue;
    if (typeof text !== "string" || !text.trim()) continue;
    turns.push({
      id,
      role,
      text,
      ...(typeof createdAt === "string" && createdAt ? { createdAt } : {}),
    });
  }
  return turns;
}

/** Drop a transcript that is only the old stub assistant. Keep real replies. */
export function normalizePersonalBotTurns(turns: readonly PersonalBotTurn[]): PersonalBotTurn[] {
  const botReplies = turns.filter((turn) => turn.role === "bot" && turn.id !== "greet");
  const onlyStubBots = botReplies.length > 0 && botReplies.every((turn) => isStubText(turn.text));
  if (onlyStubBots) return [greetingTurn()];
  const kept = turns.filter((turn) => !isStubText(turn.text));
  if (!kept.length) return [greetingTurn()];
  return kept.slice(-PERSONAL_BOT_TURN_LIMIT);
}

export function loadPersonalBotTurns(storage: PersonalBotStorage, userId: number): PersonalBotTurn[] {
  const key = personalBotStorageKey(userId);
  if (!key) return [greetingTurn()];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [greetingTurn()];
    return normalizePersonalBotTurns(sanitizeTurns(JSON.parse(raw)));
  } catch {
    return [greetingTurn()];
  }
}

export function savePersonalBotTurns(storage: PersonalBotStorage, userId: number, turns: readonly PersonalBotTurn[]): void {
  const key = personalBotStorageKey(userId);
  if (!key) return;
  const clean = sanitizeTurns([...turns]).slice(-PERSONAL_BOT_TURN_LIMIT);
  if (!clean.length) return;
  try {
    storage.setItem(key, JSON.stringify(clean));
  } catch {
    /* best-effort */
  }
}

/** Model context. Stub echoes and the local greeting stay on screen but are not sent. */
export function toPersonalBotWire(turns: readonly PersonalBotTurn[]): PersonalBotWireMessage[] {
  const out: PersonalBotWireMessage[] = [];
  for (const turn of turns) {
    const content = turn.text.trim();
    if (!content || turn.id === "greet" || isStubText(content)) continue;
    out.push({ role: turn.role === "user" ? "user" : "assistant", content });
  }
  return out.slice(-PERSONAL_BOT_WIRE_LIMIT);
}

export function parsePersonalBotReply(data: unknown): string {
  if (!data || typeof data !== "object") throw new Error(PERSONAL_BOT_LIVE_BAD);
  const reply = (data as { reply?: unknown }).reply;
  if (typeof reply !== "string" || !reply.trim()) throw new Error(PERSONAL_BOT_LIVE_BAD);
  return reply.trim();
}

export async function requestPersonalBotReply(opts: {
  userId: number;
  messages: readonly PersonalBotWireMessage[];
  url?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const url = (opts.url || UBM_PERSONAL_BOT_URL).trim();
  const messages = opts.messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.trim() }));
  if (!messages.some((m) => m.role === "user")) throw new Error(PERSONAL_BOT_LIVE_BAD);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: opts.userId, messages }),
        signal: controller.signal,
      });
    } catch {
      throw new Error(PERSONAL_BOT_LIVE_ERROR);
    }
    if (res.status >= 500) throw new Error(PERSONAL_BOT_SERVER_ERROR);
    if (!res.ok) throw new Error(PERSONAL_BOT_LIVE_BAD);
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error(PERSONAL_BOT_LIVE_BAD);
    }
    return parsePersonalBotReply(data);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Offline assistant line. Marked [스텁]; does not call a model. */
export function stubBotReply(userText: string): string {
  const text = userText.replace(/\s+/g, " ").trim();
  if (!text) return "[스텁] 무엇을 도와드릴까요?";
  if (/메일/.test(text)) return "[스텁] 메일 읽기는 아직 연결 전입니다. 찾고 싶은 제목을 한 줄로 남겨 주세요.";
  if (/결재/.test(text)) return "[스텁] 결재 조회는 다음 단계입니다. 문서 제목을 메모해 둘게요.";
  if (/일정|캘린더|회의/.test(text)) return "[스텁] 일정 연동 전입니다. 언제인지 한 줄로 남겨 주세요.";
  const chars = Array.from(text);
  const brief = chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : text;
  return `[스텁] 메모해 두었습니다. “${brief}”`;
}

export function createPersonalBotClient(env: PersonalBotEnv = personalBotEnvFromBuild(), fetchImpl?: FetchLike): PersonalBotClient {
  const url = resolvePersonalBotUrl(env);
  if (!url) {
    return {
      mode: "stub",
      reply: async ({ messages }) => {
        const last = [...messages].reverse().find((m) => m.role === "user");
        return stubBotReply(last?.content ?? "");
      },
    };
  }
  return {
    mode: "live",
    reply: (input) => requestPersonalBotReply({ ...input, url, fetchImpl }),
  };
}
