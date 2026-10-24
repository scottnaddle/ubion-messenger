/**
 * 내 봇 (1.1). Always the local PersonalBotChat session `ubm.personal-bot.v1:*`.
 * It does not open the 유비온봇 DM or the 나 room. Those stay the company bot channel
 * for group autonomy and /요약.
 *
 * Live replies go to Scott's Mac mini proxy. The desktop never holds a MiniMax key.
 *   POST http://127.0.0.1:8787/v1/personal-bot/chat
 *   body: { userId, messages, tools, connectorStatus }
 *   200: { reply } or { toolCalls: [{ id, name, arguments }] }
 * The proxy prepends PERSONAL_BOT_SYSTEM_PROMPT and calls MiniMax-M3.1-Flash.
 * It does not call Daou. The desktop executes toolCalls and posts the tool results back.
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
export const PERSONAL_BOT_TOOL_STEPS = 4;
export const PERSONAL_BOT_TOOL_ERROR = "내 봇이 도구 호출을 마치지 못했습니다.";

/** Proxy-owned system prompt. The desktop does not send this on the wire. */
export const PERSONAL_BOT_SYSTEM_PROMPT = [
  "당신은 유비온 메신저의 개인 비서입니다. 한국어로 대화하듯 답합니다.",
  "요청 본문의 tools와 connectorStatus를 따르세요.",
  "tools에 있는 도구는 데스크톱이 실행합니다. 회사 도구는 로그인된 유비온 세션을 쓰고, Google 도구는 이 기기에 저장된 토큰을 씁니다. 그 도구가 있으면 연결되지 않았다고 말하지 마세요.",
  "connectorStatus가 off 또는 connect-later인 서비스만 아직 쓸 수 없다고 말하세요. Google Drive와 Google Calendar는 연결 전에는 connect-later이고, 연결 후에는 ready입니다.",
  "회사 데이터나 Drive 문서를 보려면 최종 답 대신 toolCalls를 반환하세요. Drive는 google_drive_list로 찾은 다음 google_drive_read로 본문을 읽고, 그 텍스트만으로 한국어로 정리·요약하세요. 여러 파일은 도구 호출을 나눠 읽습니다. 도구 결과를 지어내지 마세요.",
  "Drive 파일을 만들거나 수정·삭제·이동·공유하지 않습니다. 메일 발송과 결재 승인/반려는 하지 않습니다.",
  "사용자의 문장을 되풀이하거나 \"메모해 두었습니다\"라고만 답하지 마세요.",
].join("\n");

export const PERSONAL_BOT_GREETING = "안녕하세요. 저는 유비온 비서입니다. 회사 메일, 결재 대기, 오늘 일정을 볼 수 있습니다. Google Drive와 Google 캘린더는 비서 연결에서 연결할 수 있습니다.";

export type PersonalBotRoom = {
  key: string;
  kind?: string | null;
  name?: string | null;
  isSelf?: boolean;
  peerUserId?: number;
};

export type PersonalBotTarget = { kind: "local" };

export type PersonalBotToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type PersonalBotTurn = {
  id: string;
  role: "user" | "bot" | "tool";
  text: string;
  createdAt?: string;
  toolCalls?: PersonalBotToolCall[];
  toolCallId?: string;
  toolName?: string;
};

export type PersonalBotWireMessage =
  | { role: "user" | "assistant"; content: string; toolCalls?: PersonalBotToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type PersonalBotToolSchema = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
};

export type PersonalBotConnectorStatus = { id: string; label: string; state: "ready" | "off" | "connect-later" };

export type PersonalBotChatResult = { reply: string; toolCalls: PersonalBotToolCall[] };

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
  run?(input: PersonalBotRunInput): Promise<{ reply: string; added: PersonalBotWireMessage[] }>;
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
    const toolCalls = parseStoredToolCalls((item as { toolCalls?: unknown }).toolCalls);
    const toolCallId = (item as { toolCallId?: unknown }).toolCallId;
    const toolName = (item as { toolName?: unknown }).toolName;
    if (typeof id !== "string" || !id) continue;
    if (role !== "user" && role !== "bot" && role !== "tool") continue;
    if (role === "tool") {
      if (typeof text !== "string" || typeof toolCallId !== "string" || typeof toolName !== "string") continue;
      turns.push({ id, role, text, toolCallId, toolName, ...(typeof createdAt === "string" && createdAt ? { createdAt } : {}) });
      continue;
    }
    if ((typeof text !== "string" || !text.trim()) && !toolCalls.length) continue;
    turns.push({
      id,
      role,
      text: typeof text === "string" ? text : "",
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(typeof createdAt === "string" && createdAt ? { createdAt } : {}),
    });
  }
  return turns;
}

/** Drop a transcript that is only the old stub assistant. Keep real replies. */
export function normalizePersonalBotTurns(turns: readonly PersonalBotTurn[]): PersonalBotTurn[] {
  const refreshed = turns.map((turn) => turn.id === "greet" ? { ...turn, role: "bot" as const, text: PERSONAL_BOT_GREETING } : turn);
  const botReplies = refreshed.filter((turn) => turn.role === "bot" && turn.id !== "greet" && turn.text.trim());
  const onlyStubBots = botReplies.length > 0 && botReplies.every((turn) => isStubText(turn.text));
  if (onlyStubBots) return [greetingTurn()];
  const kept = refreshed.filter((turn) => !isStubText(turn.text));
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
    if (turn.id === "greet" || isStubText(turn.text)) continue;
    if (turn.role === "tool" && turn.toolCallId && turn.toolName) {
      out.push({ role: "tool", toolCallId: turn.toolCallId, name: turn.toolName, content: turn.text });
      continue;
    }
    if (turn.role !== "user" && turn.role !== "bot") continue;
    const content = turn.text.trim();
    if (!content && !turn.toolCalls?.length) continue;
    out.push({
      role: turn.role === "user" ? "user" : "assistant",
      content,
      ...(turn.toolCalls?.length ? { toolCalls: turn.toolCalls } : {}),
    });
  }
  return out.slice(-PERSONAL_BOT_WIRE_LIMIT);
}

function parseStoredToolCalls(raw: unknown): PersonalBotToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: PersonalBotToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    const name = (item as { name?: unknown }).name;
    const args = (item as { arguments?: unknown }).arguments;
    if (typeof id !== "string" || typeof name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) continue;
    out.push({ id, name, arguments: args as Record<string, unknown> });
  }
  return out;
}

export function parsePersonalBotChatResponse(data: unknown): PersonalBotChatResult {
  if (!data || typeof data !== "object") throw new Error(PERSONAL_BOT_LIVE_BAD);
  const toolCalls = parseWireToolCalls((data as { toolCalls?: unknown }).toolCalls);
  const replyRaw = (data as { reply?: unknown }).reply;
  const reply = typeof replyRaw === "string" ? replyRaw.trim() : "";
  if (!toolCalls.length && !reply) throw new Error(PERSONAL_BOT_LIVE_BAD);
  return { reply, toolCalls };
}

function parseWireToolCalls(raw: unknown): PersonalBotToolCall[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error(PERSONAL_BOT_LIVE_BAD);
  const out: PersonalBotToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") throw new Error(PERSONAL_BOT_LIVE_BAD);
    const id = (item as { id?: unknown }).id;
    const name = (item as { name?: unknown }).name;
    let args: unknown = (item as { arguments?: unknown }).arguments ?? (item as { args?: unknown }).args ?? {};
    if (typeof args === "string") {
      try { args = JSON.parse(args) as unknown; } catch { throw new Error(PERSONAL_BOT_LIVE_BAD); }
    }
    if (typeof id !== "string" || !id || typeof name !== "string" || !name) throw new Error(PERSONAL_BOT_LIVE_BAD);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(PERSONAL_BOT_LIVE_BAD);
    out.push({ id, name, arguments: args as Record<string, unknown> });
  }
  return out;
}

export function parsePersonalBotReply(data: unknown): string {
  const parsed = parsePersonalBotChatResponse(data);
  if (parsed.toolCalls.length && !parsed.reply) throw new Error(PERSONAL_BOT_LIVE_BAD);
  if (!parsed.reply) throw new Error(PERSONAL_BOT_LIVE_BAD);
  return parsed.reply;
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

export type PersonalBotRunInput = {
  userId: number;
  messages: readonly PersonalBotWireMessage[];
  tools: readonly PersonalBotToolSchema[];
  connectorStatus: readonly PersonalBotConnectorStatus[];
  signal?: AbortSignal;
  execute(call: PersonalBotToolCall): Promise<string>;
};

export async function requestPersonalBotChat(opts: {
  userId: number;
  messages: readonly PersonalBotWireMessage[];
  tools?: readonly PersonalBotToolSchema[];
  connectorStatus?: readonly PersonalBotConnectorStatus[];
  url?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<PersonalBotChatResult> {
  const url = (opts.url || UBM_PERSONAL_BOT_URL).trim();
  const messages = opts.messages.filter((message) => {
    if (message.role === "tool") return !!message.content || message.content === "";
    return !!message.content.trim() || (message.role === "assistant" && !!message.toolCalls?.length);
  });
  if (!messages.some((message) => message.role === "user" && message.content.trim())) throw new Error(PERSONAL_BOT_LIVE_BAD);
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
        body: JSON.stringify({
          userId: opts.userId,
          messages,
          ...(opts.tools ? { tools: opts.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) } : {}),
          ...(opts.connectorStatus ? { connectorStatus: opts.connectorStatus } : {}),
        }),
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
    return parsePersonalBotChatResponse(data);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Proxy tool loop. Company tools run in `execute`, never on the proxy. */
export async function runPersonalBotTools(opts: PersonalBotRunInput & {
  post(input: {
    userId: number;
    messages: PersonalBotWireMessage[];
    tools: readonly PersonalBotToolSchema[];
    connectorStatus: readonly PersonalBotConnectorStatus[];
    signal?: AbortSignal;
  }): Promise<PersonalBotChatResult>;
  maxSteps?: number;
}): Promise<{ reply: string; added: PersonalBotWireMessage[] }> {
  const maxSteps = opts.maxSteps ?? PERSONAL_BOT_TOOL_STEPS;
  const messages = [...opts.messages];
  const added: PersonalBotWireMessage[] = [];
  for (let step = 0; step < maxSteps; step++) {
    const result = await opts.post({
      userId: opts.userId,
      messages,
      tools: opts.tools,
      connectorStatus: opts.connectorStatus,
      signal: opts.signal,
    });
    if (!result.toolCalls.length) {
      const finalMessage: PersonalBotWireMessage = { role: "assistant", content: result.reply };
      added.push(finalMessage);
      return { reply: result.reply, added };
    }
    const callMessage: PersonalBotWireMessage = { role: "assistant", content: result.reply, toolCalls: result.toolCalls };
    messages.push(callMessage);
    added.push(callMessage);
    for (const call of result.toolCalls) {
      let content: string;
      try {
        content = await opts.execute(call);
      } catch {
        content = JSON.stringify({ ok: false, code: "session", message: "회사 세션에서 가져오지 못했습니다." });
      }
      const toolMessage: PersonalBotWireMessage = { role: "tool", toolCallId: call.id, name: call.name, content };
      messages.push(toolMessage);
      added.push(toolMessage);
    }
  }
  throw new Error(PERSONAL_BOT_TOOL_ERROR);
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
    run: (input) => runPersonalBotTools({
      ...input,
      post: (body) => requestPersonalBotChat({ ...body, url, fetchImpl, signal: body.signal }),
    }),
  };
}
