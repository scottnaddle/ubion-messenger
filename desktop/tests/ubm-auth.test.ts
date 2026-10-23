import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AUTH_MARKER_RE, createUbmAuth, isAuthMarkerText, maskToken, withUbmRetry,
} from "../electron/core/ubm-auth";

const CHALLENGE_ID = "AAAAAAAAAAAAAAAA"; // 16 chars, matches the marker regex
const CODE = "BBBBBBBBBBBBBBBBBBBB"; // 20 chars
const START = Date.parse("2026-01-01T00:00:00.000Z");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const marker = (challengeId = CHALLENGE_ID, code = CODE) => `인증 코드: [[ubm:auth:${challengeId}:${code}]]`;
const dm = (text = marker(), senderSeq = 99) => ({ text, senderSeq });

function authStore(initial: { token: string; userSeq: number; expiresAt: string; botUserSeq?: number } | null = null) {
  const load = vi.fn(async () => initial);
  const save = vi.fn(async (_value: unknown) => undefined);
  return { load, save };
}

describe("token / marker helpers", () => {
  it("masks tokens without exposing short values", () => {
    expect(maskToken("abcdefghij")).toBe("abcde…ghij");
    expect(maskToken("12345678901234567890")).toBe("12345…7890");
    expect(maskToken("short")).toBe("***");
    expect(maskToken("123456789")).toBe("***");
    expect(maskToken("")).toBe("***");
    expect(maskToken(null)).toBe("***");
  });

  it("detects auth marker text without matching ordinary messages", () => {
    expect(isAuthMarkerText(marker())).toBe(true);
    expect(isAuthMarkerText("prefix [[ubm:auth:incomplete")).toBe(false);
    expect(isAuthMarkerText("[[ubm:auth:short:too-short]]")).toBe(false);
    expect(isAuthMarkerText("no marker here")).toBe(false);
    expect(isAuthMarkerText(null)).toBe(false);
    expect(isAuthMarkerText(undefined)).toBe(false);
    expect(AUTH_MARKER_RE.test(marker())).toBe(true);
    expect(AUTH_MARKER_RE.exec(marker())?.slice(1)).toEqual([CHALLENGE_ID, CODE]);
  });
});

describe("createUbmAuth login", () => {
  it("completes the PKCE challenge and DM marker flow, polling until the code arrives", async () => {
    const userSeq = 7;
    const botUserSeq = 99;
    let challengeRequest: any;
    let tokenRequest: any;
    let readCount = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v1/auth/challenge")) {
        challengeRequest = JSON.parse(String(init?.body));
        return json({ challengeId: CHALLENGE_ID, expiresAt: "2026-01-01T00:01:00.000Z", botUserSeq }, 202);
      }
      if (u.endsWith("/v1/auth/token")) {
        tokenRequest = JSON.parse(String(init?.body));
        return json({ token: "server-token-123456", userSeq, expiresAt: "2026-01-01T01:00:00.000Z" });
      }
      throw new Error(`unexpected ${u}`);
    });
    const readBotDm = vi.fn(async (botSeq: number) => {
      expect(botSeq).toBe(botUserSeq);
      readCount += 1;
      return readCount === 1 ? [dm("일반 메시지", 7)] : [dm("안내", 7), dm()];
    });
    const sleep = vi.fn(async () => undefined);
    const store = authStore();
    const auth = createUbmAuth({
      baseUrl: "https://bot.example/",
      getUserSeq: () => userSeq,
      readBotDm,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => START,
      sleep,
      pollMs: 10,
      waitMs: 1000,
      store,
    });

    await expect(auth.getToken()).resolves.toBe("server-token-123456");
    expect(readBotDm).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(challengeRequest.userSeq).toBe("7");
    expect(tokenRequest.challengeId).toBe(CHALLENGE_ID);
    expect(tokenRequest.code).toBe(CODE);

    const verifier = tokenRequest.codeVerifier as string;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challengeRequest.codeChallenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(challengeRequest.codeChallenge).not.toContain("=");

    expect(store.save).toHaveBeenCalledWith({
      token: "server-token-123456", userSeq, expiresAt: "2026-01-01T01:00:00.000Z", botUserSeq: 99,
    });
    expect(auth.botUserSeq()).toBe(99);
    expect(auth.status()).toEqual({
      userSeq, expiresAt: "2026-01-01T01:00:00.000Z", masked: "serve…3456",
    });
  });

  it("caches a fresh token and refreshes it once it expires within five minutes", async () => {
    let clock = START;
    let challenges = 0;
    let tokens = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/v1/auth/challenge")) {
        challenges += 1;
        return json({ challengeId: CHALLENGE_ID, botUserSeq: 99 }, 202);
      }
      if (u.endsWith("/v1/auth/token")) {
        tokens += 1;
        return json({
          token: `server-token-${tokens}`, userSeq: 7, expiresAt: new Date(clock + 60 * 60_000).toISOString(),
        });
      }
      throw new Error(`unexpected ${u}`);
    });
    const auth = createUbmAuth({
      baseUrl: "https://bot.example",
      getUserSeq: () => 7,
      readBotDm: async () => [dm()],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => clock,
      sleep: async () => undefined,
      store: authStore(),
    });

    await expect(auth.getToken()).resolves.toBe("server-token-1");
    await expect(auth.getToken()).resolves.toBe("server-token-1");
    expect(challenges).toBe(1);
    expect(tokens).toBe(1);

    clock = START + 56 * 60_000; // 4 minutes left → refresh
    await expect(auth.getToken()).resolves.toBe("server-token-2");
    expect(challenges).toBe(2);
    expect(tokens).toBe(2);
  });

  it("does not reuse a stored token that belongs to another userSeq", async () => {
    let challengeUserSeq = "";
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v1/auth/challenge")) {
        challengeUserSeq = JSON.parse(String(init?.body)).userSeq;
        return json({ challengeId: CHALLENGE_ID, botUserSeq: 99 }, 202);
      }
      if (u.endsWith("/v1/auth/token")) {
        return json({ token: "new-user-token", userSeq: 7, expiresAt: "2026-01-02T00:00:00.000Z" });
      }
      throw new Error(`unexpected ${u}`);
    });
    const store = authStore({ token: "old-user-token", userSeq: 5, expiresAt: "2026-01-02T00:00:00.000Z" });
    const auth = createUbmAuth({
      baseUrl: "https://bot.example",
      getUserSeq: () => 7,
      readBotDm: async () => [dm()],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => START,
      sleep: async () => undefined,
      store,
    });

    await expect(auth.getToken()).resolves.toBe("new-user-token");
    expect(challengeUserSeq).toBe("7");
    expect(store.save).toHaveBeenCalledWith({
      token: "new-user-token", userSeq: 7, expiresAt: "2026-01-02T00:00:00.000Z", botUserSeq: 99,
    });
  });

  it("shares one login across concurrent getToken calls", async () => {
    let releaseChallenge!: () => void;
    let startedChallenge!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseChallenge = resolve;
    });
    const started = new Promise<void>((resolve) => {
      startedChallenge = resolve;
    });
    let challenges = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/v1/auth/challenge")) {
        challenges += 1;
        startedChallenge();
        await gate;
        return json({ challengeId: CHALLENGE_ID, botUserSeq: 99 }, 202);
      }
      if (u.endsWith("/v1/auth/token")) {
        return json({ token: "shared-token", userSeq: 7, expiresAt: "2026-01-02T00:00:00.000Z" });
      }
      throw new Error(`unexpected ${u}`);
    });
    const readBotDm = vi.fn(async () => [dm()]);
    const auth = createUbmAuth({
      baseUrl: "https://bot.example",
      getUserSeq: () => 7,
      readBotDm,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => START,
      sleep: async () => undefined,
    });

    const calls = [auth.getToken(), auth.getToken(), auth.getToken()];
    await started;
    expect(challenges).toBe(1);
    releaseChallenge();
    await expect(Promise.all(calls)).resolves.toEqual(["shared-token", "shared-token", "shared-token"]);
    expect(challenges).toBe(1);
    expect(readBotDm).toHaveBeenCalledTimes(1);
  });

  it("times out when the DM never arrives", async () => {
    let clock = 0;
    const fetch = vi.fn(async () => json({ challengeId: CHALLENGE_ID, botUserSeq: 99 }, 202));
    const auth = createUbmAuth({
      baseUrl: "https://bot.example",
      getUserSeq: () => 7,
      readBotDm: async () => [dm("no marker")],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      pollMs: 1000,
      waitMs: 3000,
    });

    await expect(auth.getToken()).rejects.toThrow("인증 메시지를 받지 못했습니다");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("only accepts the auth marker from the bot itself", async () => {
    let clock = 0;
    const fetch = vi.fn(async () => json({ challengeId: CHALLENGE_ID, botUserSeq: 99 }, 202));
    const auth = createUbmAuth({
      baseUrl: "https://bot.example",
      getUserSeq: () => 7,
      readBotDm: async () => [dm(marker(), 7), dm(marker(), 100)],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      pollMs: 1000,
      waitMs: 3000,
    });

    await expect(auth.getToken()).rejects.toThrow("인증 메시지를 받지 못했습니다");
  });

  it("loads the persisted bot userSeq together with a stored token", async () => {
    const fetch = vi.fn();
    const auth = createUbmAuth({
      baseUrl: "https://bot.example",
      getUserSeq: () => 7,
      readBotDm: async () => [dm()],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => START,
      store: authStore({
        token: "saved-token-123456", userSeq: 7, expiresAt: "2026-01-01T01:00:00.000Z", botUserSeq: 99,
      }),
    });

    expect(auth.botUserSeq()).toBe(0);
    await expect(auth.getToken()).resolves.toBe("saved-token-123456");
    expect(auth.botUserSeq()).toBe(99);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("backs off for 60 seconds after a failed login without another challenge", async () => {
    let clock = 0;
    let challenges = 0;
    const fetch = vi.fn(async () => {
      challenges += 1;
      return json({ error: { code: "upstream_error" } }, 502);
    });
    const auth = createUbmAuth({
      baseUrl: "https://bot.example",
      getUserSeq: () => 7,
      readBotDm: async () => [dm()],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => clock,
      sleep: async () => undefined,
    });

    await expect(auth.getToken()).rejects.toThrow("인증 서버에 일시적인 오류");
    expect(challenges).toBe(1);

    await expect(auth.getToken()).rejects.toThrow("잠시 후 다시 시도하세요");
    clock = 59_999;
    await expect(auth.getToken()).rejects.toThrow("잠시 후 다시 시도하세요");
    expect(challenges).toBe(1);

    clock = 60_000;
    await expect(auth.getToken()).rejects.toThrow("인증 서버에 일시적인 오류");
    expect(challenges).toBe(2);
  });

  it("doubles the backoff after each failure and caps it at 30 minutes", async () => {
    let clock = 0;
    let challenges = 0;
    const fetch = vi.fn(async () => {
      challenges += 1;
      return json({ error: { code: "upstream_error" } }, 502);
    });
    const auth = createUbmAuth({
      baseUrl: "https://bot.example",
      getUserSeq: () => 7,
      readBotDm: async () => [dm()],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => clock,
      sleep: async () => undefined,
    });

    const delays = [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000];
    for (let i = 0; i < delays.length; i += 1) {
      await expect(auth.getToken()).rejects.toThrow("인증 서버에 일시적인 오류");
      expect(challenges).toBe(i + 1);
      await expect(auth.getToken()).rejects.toThrow("잠시 후 다시 시도하세요");
      clock += delays[i] - 1;
      await expect(auth.getToken()).rejects.toThrow("잠시 후 다시 시도하세요");
      expect(challenges).toBe(i + 1);
      clock += 1;
    }
  });

  it.each([404, 403])("stops automatic logins for the session when the challenge returns %i", async (status) => {
    let clock = 0;
    let challengeCalls = 0;
    let challengeBody: any;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v1/auth/challenge")) {
        challengeCalls += 1;
        challengeBody = JSON.parse(String(init?.body));
        if (challengeCalls === 1) return json({ error: "unsupported" }, status);
        return json({ challengeId: CHALLENGE_ID, botUserSeq: 99 }, 202);
      }
      if (u.endsWith("/v1/auth/token")) {
        return json({ token: "recovered-token", userSeq: 7, expiresAt: "2026-01-02T00:00:00.000Z" });
      }
      throw new Error(`unexpected ${u}`);
    });
    const auth = createUbmAuth({
      baseUrl: "https://bot.example",
      getUserSeq: () => 7,
      readBotDm: async () => [dm()],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => clock,
      sleep: async () => undefined,
    });

    await expect(auth.getToken()).rejects.toThrow("자동 로그인을 사용할 수 없습니다");
    expect(challengeCalls).toBe(1);
    clock += 24 * 60 * 60_000;
    await expect(auth.getToken()).rejects.toThrow("자동 로그인을 사용할 수 없습니다");
    expect(challengeCalls).toBe(1);

    await auth.logout();
    await expect(auth.getToken()).resolves.toBe("recovered-token");
    expect(challengeCalls).toBe(2);
    expect(challengeBody.userSeq).toBe("7");
    expect(auth.botUserSeq()).toBe(99);
  });

  it("resets the automatic-login stop when the account changes", async () => {
    let seq = 7;
    let challengeCalls = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v1/auth/challenge")) {
        challengeCalls += 1;
        if (challengeCalls === 1) return json({ error: "unsupported" }, 404);
        expect(JSON.parse(String(init?.body)).userSeq).toBe("8");
        return json({ challengeId: CHALLENGE_ID, botUserSeq: 99 }, 202);
      }
      if (u.endsWith("/v1/auth/token")) {
        return json({ token: "account-8-token", userSeq: 8, expiresAt: "2026-01-02T00:00:00.000Z" });
      }
      throw new Error(`unexpected ${u}`);
    });
    const auth = createUbmAuth({
      baseUrl: "https://bot.example",
      getUserSeq: () => seq,
      readBotDm: async () => [dm()],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => START,
      sleep: async () => undefined,
    });

    await expect(auth.getToken()).rejects.toThrow("자동 로그인을 사용할 수 없습니다");
    seq = 8;
    await expect(auth.getToken()).resolves.toBe("account-8-token");
    expect(challengeCalls).toBe(2);
  });

  it("discards a login that finishes after logout", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/v1/auth/challenge")) {
        started();
        await gate;
        return json({ challengeId: CHALLENGE_ID, botUserSeq: 99 }, 202);
      }
      if (u.endsWith("/v1/auth/token")) {
        return json({ token: "late-token-123456", userSeq: 7, expiresAt: "2026-01-02T00:00:00.000Z" });
      }
      throw new Error(`unexpected ${u}`);
    });
    const store = authStore();
    const auth = createUbmAuth({
      baseUrl: "https://bot.example",
      getUserSeq: () => 7,
      readBotDm: async () => [dm()],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => START,
      sleep: async () => undefined,
      store,
    });

    const pending = auth.getToken();
    await startedP;
    await auth.logout();
    release();
    await expect(pending).rejects.toThrow("로그인이 취소되었습니다");
    expect(store.save).not.toHaveBeenCalledWith(expect.objectContaining({ token: "late-token-123456" }));
    expect(store.save).toHaveBeenLastCalledWith(null);
    expect(auth.status()).toEqual({});
  });

  it("discards a login that finishes after invalidate", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/v1/auth/challenge")) {
        started();
        await gate;
        return json({ challengeId: CHALLENGE_ID, botUserSeq: 99 }, 202);
      }
      if (u.endsWith("/v1/auth/token")) {
        return json({ token: "late-token-654321", userSeq: 7, expiresAt: "2026-01-02T00:00:00.000Z" });
      }
      throw new Error(`unexpected ${u}`);
    });
    const store = authStore();
    const auth = createUbmAuth({
      baseUrl: "https://bot.example",
      getUserSeq: () => 7,
      readBotDm: async () => [dm()],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => START,
      sleep: async () => undefined,
      store,
    });

    const pending = auth.getToken();
    await startedP;
    await auth.invalidate();
    release();
    await expect(pending).rejects.toThrow("로그인이 취소되었습니다");
    expect(store.save).not.toHaveBeenCalledWith(expect.objectContaining({ token: "late-token-654321" }));
    expect(store.save).toHaveBeenLastCalledWith(null);
    expect(auth.status()).toEqual({});
  });

  it("discards a login that finishes after the account changes", async () => {
    let seq = 7;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    let challengeCalls = 0;
    let tokenCalls = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/v1/auth/challenge")) {
        challengeCalls += 1;
        if (challengeCalls === 1) {
          started();
          await gate;
        }
        return json({ challengeId: CHALLENGE_ID, botUserSeq: 99 }, 202);
      }
      if (u.endsWith("/v1/auth/token")) {
        tokenCalls += 1;
        return json({
          token: `account-token-${tokenCalls}`,
          userSeq: tokenCalls === 1 ? 7 : 8,
          expiresAt: "2026-01-02T00:00:00.000Z",
        });
      }
      throw new Error(`unexpected ${u}`);
    });
    const store = authStore();
    const auth = createUbmAuth({
      baseUrl: "https://bot.example",
      getUserSeq: () => seq,
      readBotDm: async () => [dm()],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => START,
      sleep: async () => undefined,
      store,
    });

    const pending = auth.getToken();
    await startedP;
    seq = 8;
    release();
    await expect(pending).rejects.toThrow("로그인이 취소되었습니다");
    expect(store.save).not.toHaveBeenCalledWith(expect.objectContaining({ token: "account-token-1" }));
    expect(auth.status()).toEqual({});
    await expect(auth.getToken()).resolves.toBe("account-token-2");
    expect(store.save).toHaveBeenLastCalledWith({
      token: "account-token-2", userSeq: 8, expiresAt: "2026-01-02T00:00:00.000Z", botUserSeq: 99,
    });
  });

  it("invalidates the cached token and logs out on the server", async () => {
    let tokens = 0;
    let logouts = 0;
    let logoutHeaders: any;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v1/auth/challenge")) {
        return json({ challengeId: CHALLENGE_ID, botUserSeq: 99 }, 202);
      }
      if (u.endsWith("/v1/auth/token")) {
        tokens += 1;
        return json({ token: `server-token-${tokens}`, userSeq: 7, expiresAt: "2026-01-02T00:00:00.000Z" });
      }
      if (u.endsWith("/v1/auth/logout")) {
        logouts += 1;
        logoutHeaders = init?.headers;
        return json({ ok: true });
      }
      throw new Error(`unexpected ${u}`);
    });
    const store = authStore();
    const auth = createUbmAuth({
      baseUrl: "https://bot.example",
      getUserSeq: () => 7,
      readBotDm: async () => [dm()],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => START,
      sleep: async () => undefined,
      store,
    });

    await expect(auth.getToken()).resolves.toBe("server-token-1");
    await auth.invalidate();
    expect(auth.status()).toEqual({});
    expect(store.save).toHaveBeenLastCalledWith(null);
    await expect(auth.getToken()).resolves.toBe("server-token-2");

    await auth.logout();
    expect(logouts).toBe(1);
    expect(logoutHeaders).toMatchObject({ "X-UBM-User-Seq": "7", "X-UBM-Session": "server-token-2" });
    expect(auth.status()).toEqual({});
    expect(store.save).toHaveBeenLastCalledWith(null);
  });

  it("keeps token, code and verifier out of errors and console output", async () => {
    const secretToken = "super-secret-token-value";
    let verifier = "";
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/v1/auth/challenge")) {
        return json({ challengeId: CHALLENGE_ID, botUserSeq: 99 }, 202);
      }
      if (u.endsWith("/v1/auth/token")) {
        verifier = JSON.parse(String(init?.body)).codeVerifier;
        return json({ error: { token: secretToken, code: CODE, verifier } }, 401);
      }
      throw new Error(`unexpected ${u}`);
    });
    const consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    const auth = createUbmAuth({
      baseUrl: "https://bot.example",
      getUserSeq: () => 7,
      readBotDm: async () => [dm()],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => START,
      sleep: async () => undefined,
    });

    let message = "";
    try {
      await auth.getToken();
      throw new Error("expected getToken to reject");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("인증");
    expect(message).not.toContain(secretToken);
    expect(message).not.toContain(CODE);
    expect(message).not.toContain(verifier);
    expect(verifier.length).toBeGreaterThan(0);

    const logged = consoleSpies.map((s) => s.mock.calls.flat().join(" ")).join(" ");
    expect(logged).not.toContain(secretToken);
    expect(logged).not.toContain(CODE);
    expect(logged).not.toContain(verifier);
    consoleSpies.forEach((s) => s.mockRestore());
  });
});

describe("withUbmRetry", () => {
  it("invalidates once and retries once after an auth failure", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: "세션이 만료되었습니다. 다시 로그인하세요." })
      .mockResolvedValueOnce({ ok: true, data: 1 });
    const invalidate = vi.fn(async () => undefined);

    const result = await withUbmRetry(
      run,
      invalidate,
      (r) => !r.ok && r.message === "세션이 만료되었습니다. 다시 로그인하세요.",
    );

    expect(result).toEqual({ ok: true, data: 1 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-auth failure", async () => {
    const run = vi.fn(async () => ({ ok: false, message: "다른 오류" }));
    const invalidate = vi.fn(async () => undefined);
    await withUbmRetry(run, invalidate, (r) => !r.ok && r.message === "auth");
    expect(run).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
