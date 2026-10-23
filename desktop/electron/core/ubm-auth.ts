/**
 * UBION server auth (bot.ubion.global) without ever forwarding DaouOffice cookies.
 *
 * Flow: PKCE challenge → the bot sends a 1:1 DaouOffice DM containing a hidden marker → exchange the
 * code for a UBION session token. The token is cached per DaouOffice userSeq and only refreshed when it
 * is missing, belongs to another user, or expires within five minutes. Concurrent getToken() calls share
 * one login, and a failed login backs off for 60 s so we never spam the user's DM.
 *
 * Secrets (token, code, verifier) are never included in errors or logs.
 */

import { createHash, randomBytes } from "node:crypto";
import { AUTH_MARKER_RE, isAuthMarkerText } from "../../src/lib/markers";

export { AUTH_MARKER_RE, isAuthMarkerText };

export const UBM_AUTH_BACKOFF_MS = 60_000;
export const UBM_AUTH_BACKOFF_MAX_MS = 30 * 60_000;
export const UBM_AUTH_REFRESH_MS = 5 * 60_000;

const MAX_TOKEN_LENGTH = 4096;
const DEFAULT_POLL_MS = 1500;
const DEFAULT_WAIT_MS = 30_000;

export type UbmAuthToken = {
  token: string;
  userSeq: number;
  expiresAt: string;
  /** DaouOffice userSeq of the bot that sends the auth DM; persisted with the token. */
  botUserSeq?: number;
};

export type UbmTokenStore = {
  load(): Promise<UbmAuthToken | null>;
  save(value: UbmAuthToken | null): Promise<void>;
};

export type UbmAuthStatus = {
  userSeq?: number;
  expiresAt?: string;
  masked?: string;
};

export type UbmAuthDm = { text: string; senderSeq?: number };

export type UbmAuthOptions = {
  baseUrl?: string;
  getUserSeq: () => number;
  /** Recent messages of the 1:1 room with the bot (newest first or last — order does not matter). */
  readBotDm: (botUserSeq: number) => Promise<UbmAuthDm[]>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  waitMs?: number;
  store?: UbmTokenStore;
};

export type UbmAuth = {
  getToken(): Promise<string>;
  invalidate(): Promise<void>;
  logout(): Promise<void>;
  status(): UbmAuthStatus;
  /** Known bot userSeq (0 until a challenge succeeds); used to recognize auth DMs without trusting text alone. */
  botUserSeq(): number;
};

const MESSAGES = {
  loginRequired: "로그인이 필요합니다",
  backoff: "인증 시도가 너무 많습니다. 잠시 후 다시 시도하세요.",
  network: "봇 서버에 연결할 수 없습니다.",
  rateLimited: "인증 요청이 너무 많습니다. 잠시 후 다시 시도하세요.",
  roomNotAllowed: "봇과의 1:1 대화방에서 인증할 수 없습니다.",
  upstream: "인증 서버에 일시적인 오류가 발생했습니다.",
  startFailed: "인증을 시작하지 못했습니다. 잠시 후 다시 시도하세요.",
  timeout: "인증 메시지를 받지 못했습니다. 잠시 후 다시 시도하세요.",
  invalidCode: "인증 코드가 올바르지 않습니다. 다시 시도하세요.",
  badResponse: "인증 서버 응답을 확인할 수 없습니다.",
  userMismatch: "인증 사용자 정보가 일치하지 않습니다.",
  dmUnavailable: "봇 대화방의 메시지를 확인할 수 없습니다.",
  autoLoginUnavailable: "이 서버에서는 자동 로그인을 사용할 수 없습니다. 다시 로그인하세요.",
  loginCancelled: "로그인이 취소되었습니다. 다시 시도하세요.",
} as const;

/** Mask a token for logging: first 5 + … + last 4, or *** when it is too short to reveal safely. */
export function maskToken(token: unknown): string {
  if (typeof token !== "string" || token.length < 10) return "***";
  return `${token.slice(0, 5)}…${token.slice(-4)}`;
}

function positiveSeq(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** 60 s, 2 min, 4 min … capped at 30 min after consecutive failures. */
function backoffMs(failures: number): number {
  return Math.min(UBM_AUTH_BACKOFF_MAX_MS, UBM_AUTH_BACKOFF_MS * 2 ** Math.max(0, failures - 1));
}

function httpError(status: number, fallback: string): Error {
  if (status === 403) return new Error(MESSAGES.roomNotAllowed);
  if (status === 429) return new Error(MESSAGES.rateLimited);
  if (status === 502) return new Error(MESSAGES.upstream);
  return new Error(fallback);
}

async function readJson(res: Response): Promise<any> {
  try {
    if (typeof res.text === "function") {
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
    if (typeof (res as any).json === "function") return await (res as any).json();
  } catch {
    return null;
  }
  return null;
}

function findCode(texts: unknown, challengeId: string): string | null {
  if (!Array.isArray(texts)) return null;
  const re = new RegExp(AUTH_MARKER_RE.source, "g");
  for (const text of texts) {
    if (typeof text !== "string") continue;
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      if (match[1] === challengeId) return match[2];
    }
  }
  return null;
}

/**
 * Run a request once; if it reports an auth failure, invalidate the cached token and run it once more.
 * Pure helper so every bot.ubion.global client uses the same 401 → invalidate → retry policy.
 */
export async function withUbmRetry<T>(
  run: () => Promise<T>,
  invalidate: () => Promise<void> | void,
  isUnauthorized: (result: T) => boolean
): Promise<T> {
  const first = await run();
  if (!isUnauthorized(first)) return first;
  try {
    await invalidate();
  } catch {
    /* retry still needs to happen even if clearing the local token failed */
  }
  return run();
}

export function createUbmAuth({
  baseUrl = "https://bot.ubion.global",
  getUserSeq,
  readBotDm,
  fetch: fetchImpl,
  now = () => Date.now(),
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  pollMs = DEFAULT_POLL_MS,
  waitMs = DEFAULT_WAIT_MS,
  store,
}: UbmAuthOptions): UbmAuth {
  const root = String(baseUrl).replace(/\/+$/, "");
  const pollEvery = Math.max(1, Math.floor(pollMs));
  const waitFor = Math.max(0, Math.floor(waitMs));

  let token: UbmAuthToken | null = null;
  let botSeq = 0;
  let loaded = false;
  let loadPromise: Promise<void> | null = null;
  let loginPromise: Promise<string> | null = null;
  let loginAttempt = 0;
  let generation = 0;
  let lastSeq = 0;
  let blockedUntil = 0;
  let failures = 0;
  /** 404/403 on /v1/auth/challenge means this app session cannot use DM auth; stay quiet until logout/account change. */
  let autoLoginStopped = false;

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    if (!loadPromise) {
      const genAtLoad = generation;
      loadPromise = (async () => {
        if (!store) return;
        try {
          const saved = await store.load();
          if (
            genAtLoad === generation &&
            saved &&
            typeof saved.token === "string" &&
            saved.token.length > 0 &&
            saved.token.length <= MAX_TOKEN_LENGTH &&
            !/[\r\n]/.test(saved.token) &&
            positiveSeq(saved.userSeq) > 0 &&
            typeof saved.expiresAt === "string" &&
            Number.isFinite(Date.parse(saved.expiresAt))
          ) {
            const savedBotSeq = positiveSeq(saved.botUserSeq);
            token = {
              token: saved.token,
              userSeq: Number(saved.userSeq),
              expiresAt: saved.expiresAt,
              ...(savedBotSeq > 0 ? { botUserSeq: savedBotSeq } : {}),
            };
            if (savedBotSeq > 0) botSeq = savedBotSeq;
          }
        } catch {
          /* an unreadable store is treated as empty */
        }
      })().finally(() => {
        loaded = true;
        loadPromise = null;
      });
    }
    await loadPromise;
  }

  async function save(next: UbmAuthToken | null): Promise<void> {
    if (!store) return;
    try {
      await store.save(next);
    } catch {
      /* persistence is best-effort; keep the token in memory */
    }
  }

  function fresh(candidate: UbmAuthToken | null, userSeq: number): candidate is UbmAuthToken {
    if (!candidate || candidate.userSeq !== userSeq) return false;
    const expires = Date.parse(candidate.expiresAt);
    return Number.isFinite(expires) && expires - now() > UBM_AUTH_REFRESH_MS;
  }

  /** Account change: invalidate any in-flight login and all per-account backoff/stop state. */
  function resetForAccount(seq: number) {
    generation += 1;
    loginAttempt += 1;
    loginPromise = null;
    token = null;
    botSeq = 0;
    blockedUntil = 0;
    failures = 0;
    autoLoginStopped = false;
    lastSeq = seq;
  }

  async function requestChallenge(userSeq: number) {
    const verifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
    const doFetch = fetchImpl ?? globalThis.fetch;

    let res: Response;
    try {
      res = await doFetch(`${root}/v1/auth/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userSeq: String(userSeq), codeChallenge }),
      });
    } catch {
      throw new Error(MESSAGES.network);
    }

    // 404/403: the server has no DM-challenge auth or the bot may not DM us. Retrying only spams failures.
    if (res.status === 404 || res.status === 403) throw new Error(MESSAGES.autoLoginUnavailable);
    if (res.status < 200 || res.status >= 300) throw httpError(res.status, MESSAGES.startFailed);
    const data = await readJson(res);
    const challengeId = typeof data?.challengeId === "string" ? data.challengeId : "";
    const botUserSeq = positiveSeq(data?.botUserSeq);
    if (!challengeId || challengeId.length > 64 || botUserSeq <= 0) throw new Error(MESSAGES.badResponse);
    return { verifier, challengeId, botUserSeq };
  }

  async function waitForCode(botUserSeq: number, challengeId: string): Promise<string> {
    const deadline = now() + waitFor;
    const maxPolls = Math.max(1, Math.ceil(waitFor / pollEvery) + 1);
    let polls = 0;
    while (true) {
      polls += 1;
      let entries: UbmAuthDm[];
      try {
        entries = await readBotDm(botUserSeq);
      } catch {
        throw new Error(MESSAGES.dmUnavailable);
      }
      // A marker in a spoofed/non-bot message must never be consumed as our code.
      const texts = entries
        .filter((m) => m && positiveSeq(m.senderSeq) === botUserSeq)
        .map((m) => m.text);
      const code = findCode(texts, challengeId);
      if (code) return code;
      const remaining = deadline - now();
      if (remaining <= 0 || polls >= maxPolls) throw new Error(MESSAGES.timeout);
      await sleep(Math.min(pollEvery, remaining));
    }
  }

  async function exchange(seq: number, challengeId: string, code: string, verifier: string): Promise<UbmAuthToken> {
    const doFetch = fetchImpl ?? globalThis.fetch;
    let res: Response;
    try {
      res = await doFetch(`${root}/v1/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, code, codeVerifier: verifier }),
      });
    } catch {
      throw new Error(MESSAGES.network);
    }

    if (res.status === 401) throw new Error(MESSAGES.invalidCode);
    if (res.status < 200 || res.status >= 300) throw httpError(res.status, MESSAGES.badResponse);

    const data = await readJson(res);
    const value = typeof data?.token === "string" ? data.token : "";
    const userSeq = positiveSeq(data?.userSeq);
    const expiresAt = typeof data?.expiresAt === "string" ? data.expiresAt : "";
    if (
      !value ||
      value.length > MAX_TOKEN_LENGTH ||
      /[\r\n]/.test(value) ||
      userSeq <= 0 ||
      !Number.isFinite(Date.parse(expiresAt))
    ) {
      throw new Error(MESSAGES.badResponse);
    }
    if (userSeq !== seq) throw new Error(MESSAGES.userMismatch);
    return { token: value, userSeq, expiresAt };
  }

  async function login(seq: number): Promise<UbmAuthToken> {
    const challenge = await requestChallenge(seq);
    const code = await waitForCode(challenge.botUserSeq, challenge.challengeId);
    const next = await exchange(seq, challenge.challengeId, code, challenge.verifier);
    return { ...next, botUserSeq: challenge.botUserSeq };
  }

  async function getToken(): Promise<string> {
    await ensureLoaded();
    const seq = positiveSeq(getUserSeq());
    if (seq <= 0) throw new Error(MESSAGES.loginRequired);
    if (lastSeq > 0 && seq !== lastSeq) {
      resetForAccount(seq);
      await save(null);
    } else {
      lastSeq = seq;
    }
    if (autoLoginStopped) throw new Error(MESSAGES.autoLoginUnavailable);
    if (fresh(token, seq)) return token.token;

    const current = now();
    if (current < blockedUntil) throw new Error(MESSAGES.backoff);
    if (loginPromise) return loginPromise;

    const gen = generation;
    const attempt = ++loginAttempt;
    const running = (async (): Promise<string> => {
      try {
        const next = await login(seq);
        if (gen !== generation) throw new Error(MESSAGES.loginCancelled);
        const seqNow = positiveSeq(getUserSeq());
        if (seqNow !== seq) {
          // Account changed while the challenge was in flight: never cache/save the old account's token.
          resetForAccount(seqNow);
          await save(null);
          throw new Error(MESSAGES.loginCancelled);
        }
        token = next;
        if (next.botUserSeq) botSeq = next.botUserSeq;
        blockedUntil = 0;
        failures = 0;
        autoLoginStopped = false;
        await save(next);
        return next.token;
      } catch (e) {
        if (gen !== generation) throw e instanceof Error ? e : new Error(MESSAGES.badResponse);
        const seqNow = positiveSeq(getUserSeq());
        if (seqNow !== seq) {
          resetForAccount(seqNow);
          await save(null);
          throw new Error(MESSAGES.loginCancelled);
        }
        if (e instanceof Error && e.message === MESSAGES.autoLoginUnavailable) {
          autoLoginStopped = true;
          blockedUntil = 0;
          failures = 0;
        } else {
          failures += 1;
          blockedUntil = now() + backoffMs(failures);
        }
        throw e instanceof Error ? e : new Error(MESSAGES.badResponse);
      } finally {
        if (loginAttempt === attempt) loginPromise = null;
      }
    })();
    loginPromise = running;
    return running;
  }

  async function invalidate(): Promise<void> {
    generation += 1;
    loginAttempt += 1;
    loginPromise = null;
    token = null;
    await save(null);
  }

  async function logout(): Promise<void> {
    const current = token;
    generation += 1;
    loginAttempt += 1;
    loginPromise = null;
    token = null;
    botSeq = 0;
    blockedUntil = 0;
    failures = 0;
    autoLoginStopped = false;
    lastSeq = 0;
    loaded = true;
    if (current) {
      const doFetch = fetchImpl ?? globalThis.fetch;
      try {
        await doFetch(`${root}/v1/auth/logout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-UBM-User-Seq": String(current.userSeq),
            "X-UBM-Session": current.token,
          },
        });
      } catch {
        /* local logout succeeds even if the server is unreachable */
      }
    }
    await save(null);
  }

  function status(): UbmAuthStatus {
    if (!token) return {};
    return { userSeq: token.userSeq, expiresAt: token.expiresAt, masked: maskToken(token.token) };
  }

  return { getToken, invalidate, logout, status, botUserSeq: () => botSeq };
}
