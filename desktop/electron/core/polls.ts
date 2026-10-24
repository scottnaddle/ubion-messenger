/**
 * 투표(poll): our own server (UBM_BOT_API_URL / bot.ubion.global). Behind UBM_POLLS=1 (default off).
 * The bot posts the poll message — carrying a [[ubm:poll:<id>]] marker — and the results to the room,
 * so original-app users see a readable plain-text question while UBION renders an interactive card.
 *
 * ⚠ UNVERIFIED request shape:
 *   POST {base}/v1/polls            body { roomSeq, question, options, multiSelect, deadline? } → 200 poll
 *   GET  {base}/v1/polls/{id}       → 200 poll
 *   POST {base}/v1/polls/{id}/vote  body { optionIndex } → 200 poll (toggles the caller's vote)
 *   POST {base}/v1/polls/{id}/close → 200 poll (closed: true)
 * poll = { id, roomSeq, question, options: string[], multiSelect, deadline?, closed, votes: { [optionIndex]: number[] } }
 * Auth headers: X-UBM-User-Seq (caller seq) + X-UBM-Session (ubt1 server token, never a Daou cookie).
 * X-UBM-Tenant is sent only when getTenantHost returns a host. UBION omits it. Never logged.
 */

import { checkForwardTarget } from "./forward";
import { resolveTenantHeader, ubmRequestHeaders } from "./tenant";

export const POLLS_ENV = "UBM_POLLS";
export const POLLS_DISABLED_TEXT = "투표는 아직 지원되지 않습니다";
export const POLL_MAX_QUESTION = 500;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_MAX_OPTION = 200;
const MAX_SESSION_LENGTH = 4096;

export type PollCaps = { enabled: boolean; selfOnly: boolean };

export type PollInput = {
  roomSeq: number;
  question: string;
  options: string[];
  multiSelect: boolean;
  deadline?: number;
};

/** optionIndex → userSeqs that voted. */
export type Poll = {
  id: number;
  roomSeq: number;
  question: string;
  options: string[];
  multiSelect: boolean;
  deadline?: number;
  closed: boolean;
  votes: Record<number, number[]>;
};

export type PollsOptions = {
  baseUrl?: string;
  getUserSeq: () => number;
  getSessionHeader: () => Promise<string>;
  /** Daou server host for a future multi-tenant bot. Empty omits X-UBM-Tenant. */
  getTenantHost?: () => string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export type PollsResult<T = Poll> = { ok: true; data: T } | { ok: false; message: string };

export function pollsEnabled(env: Record<string, string | undefined> | undefined): boolean {
  return env?.[POLLS_ENV] === "1";
}

export function pollsCaps(env: Record<string, string | undefined> | undefined): PollCaps {
  return { enabled: pollsEnabled(env), selfOnly: env?.UBM_SELF_ONLY === "1" };
}

function positiveSeq(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label}가 올바르지 않습니다`);
  return n;
}

export function normalizePollId(value: unknown): number {
  return positiveSeq(value, "투표");
}

function normalizeDeadline(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error("마감 시간이 올바르지 않습니다");
  return n;
}

/** Coerce the create payload into a valid PollInput (Korean error strings). */
export function normalizePollInput(value: unknown): PollInput {
  const o = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const roomSeq = positiveSeq(o.roomSeq, "대화방");
  const question = typeof o.question === "string" ? o.question.trim() : "";
  if (!question) throw new Error("질문을 입력하세요");
  if (question.length > POLL_MAX_QUESTION) throw new Error(`질문은 ${POLL_MAX_QUESTION}자까지 입력할 수 있습니다`);
  const rawOptions = Array.isArray(o.options) ? o.options : [];
  const options = rawOptions.map((v) => (typeof v === "string" ? v.trim() : "")).filter((v) => v);
  if (options.length < POLL_MIN_OPTIONS) throw new Error("선택지를 2개 이상 입력하세요");
  if (options.length > POLL_MAX_OPTIONS) throw new Error(`선택지는 최대 ${POLL_MAX_OPTIONS}개까지 입력할 수 있습니다`);
  for (const opt of options) {
    if (opt.length > POLL_MAX_OPTION) throw new Error(`선택지는 ${POLL_MAX_OPTION}자까지 입력할 수 있습니다`);
  }
  const multiSelect = o.multiSelect === true;
  const deadline = normalizeDeadline(o.deadline);
  return { roomSeq, question, options, multiSelect, deadline };
}

export function normalizeOptionIndex(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("선택지를 선택하세요");
  return n;
}

function toSeqs(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map((s) => Number(s)).filter((n) => Number.isSafeInteger(n) && n > 0)
    : [];
}

/** Parse/coerce the documented poll response into a Poll. */
export function parsePoll(body: unknown): Poll | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const id = Number(o.id);
  const roomSeq = Number(o.roomSeq);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const options = Array.isArray(o.options) ? o.options.filter((v): v is string => typeof v === "string") : [];
  const votes: Record<number, number[]> = {};
  if (o.votes && typeof o.votes === "object") {
    for (const [idx, seqs] of Object.entries(o.votes as Record<string, unknown>)) {
      const n = Number(idx);
      const list = toSeqs(seqs);
      if (Number.isSafeInteger(n) && n >= 0 && list.length) votes[n] = list;
    }
  }
  return {
    id,
    roomSeq: Number.isSafeInteger(roomSeq) && roomSeq > 0 ? roomSeq : 0,
    question: typeof o.question === "string" ? o.question : "",
    options,
    multiSelect: o.multiSelect === true,
    deadline: typeof o.deadline === "number" && Number.isFinite(o.deadline) ? o.deadline : undefined,
    closed: o.closed === true,
    votes,
  };
}

/** Self-only guard for creating a poll — reuses the shared forward/notice guard (poll triggers a bot message). */
export function guardPollRoom({
  selfOnly,
  roomSeq,
  me,
  selfRoomSeq,
}: {
  selfOnly: boolean;
  roomSeq: number;
  me: number;
  selfRoomSeq?: number | null;
}): void {
  checkForwardTarget({ selfOnly, target: { roomSeq }, me, selfRoomSeq });
}

export function createPollsClient({
  baseUrl = "https://bot.ubion.global",
  getUserSeq,
  getSessionHeader,
  getTenantHost,
  fetch: fetchImpl,
  timeoutMs = 8000,
}: PollsOptions) {
  const root = String(baseUrl).replace(/\/+$/, "");

  async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<PollsResult> {
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
      return { ok: false, message: "투표 서버에 연결할 수 없습니다." };
    } finally {
      clearTimeout(timer);
    }

    let text = "";
    try {
      text = await res.text();
    } catch {
      return { ok: false, message: "투표 서버에 연결할 수 없습니다." };
    }
    if (res.status === 401) return { ok: false, message: "세션이 만료되었습니다. 다시 로그인하세요." };
    if (res.status < 200 || res.status >= 300) return { ok: false, message: "투표 서버에서 처리하지 못했습니다." };

    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const poll = parsePoll(data);
    if (!poll) return { ok: false, message: "투표 서버 응답을 확인할 수 없습니다." };
    return { ok: true, data: poll };
  }

  return {
    create: (input: PollInput): Promise<PollsResult> =>
      request("POST", "/v1/polls", {
        roomSeq: input.roomSeq,
        question: input.question,
        options: input.options,
        multiSelect: input.multiSelect,
        ...(input.deadline != null ? { deadline: input.deadline } : {}),
      }),
    get: (id: number): Promise<PollsResult> =>
      request("GET", `/v1/polls/${encodeURIComponent(String(id))}`),
    vote: (id: number, optionIndex: number): Promise<PollsResult> =>
      request("POST", `/v1/polls/${encodeURIComponent(String(id))}/vote`, { optionIndex }),
    close: (id: number): Promise<PollsResult> =>
      request("POST", `/v1/polls/${encodeURIComponent(String(id))}/close`),
  };
}
