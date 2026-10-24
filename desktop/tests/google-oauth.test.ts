import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  advertisedTools,
  resolveConnectors,
  saveConnectorPrefs,
  type ConnectorPrefs,
} from "../src/lib/connectors";
import { GoogleConnectorHost, type GoogleFetch } from "../electron/core/google-session";
import {
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_DRIVE_SCOPE,
  GoogleConnectError,
  appendGoogleOAuthDebugLog,
  calendarTodayUrl,
  cleanClientId,
  createPkce,
  driveListUrl,
  dropToken,
  emptyTokenFile,
  googleAuthorizeUrl,
  googleTokenRequest,
  isGoogleAuthCode,
  localDayRange,
  oauthCallbackMessage,
  oauthTokenFailureMessage,
  openOAuthLoopback,
  parseCalendarEvents,
  parseDriveFiles,
  parseGoogleTokenResponse,
  parseTokenFile,
  putToken,
  resolveGoogleClientConfig,
  serializeTokenFile,
  tokenStatus,
  type GoogleTokenFile,
} from "../electron/core/google-oauth";

const CLIENT = "1234567890-alpha.apps.googleusercontent.com";

function jsonResponse(status: number, body: unknown) {
  return { status, json: async () => body };
}

function rawGet(redirectUri: string, query: string): Promise<{ status: number; body: string }> {
  const u = new URL(redirectUri);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: u.port,
      path: `${u.pathname}?${query}`,
      method: "GET",
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk as Buffer));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("google oauth protocol", () => {
  it("builds a PKCE authorize URL with one read scope and no secret", () => {
    const { verifier, challenge } = createPkce(Buffer.from("0123456789abcdef0123456789abcdef"));
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    const url = googleAuthorizeUrl({
      clientId: CLIENT,
      redirectUri: "http://127.0.0.1:42813/callback",
      scope: GOOGLE_DRIVE_SCOPE,
      state: "state-value",
      codeChallenge: challenge,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(GOOGLE_DRIVE_SCOPE).toBe("https://www.googleapis.com/auth/drive.readonly");
    expect(parsed.searchParams.get("scope")?.split(" ")).toEqual([GOOGLE_DRIVE_SCOPE]);
    expect(parsed.searchParams.get("scope")).not.toContain("metadata");
    expect(parsed.searchParams.get("scope")).not.toContain("drive.file");
    expect(parsed.searchParams.get("scope")).not.toBe(GOOGLE_CALENDAR_SCOPE);
    expect(parsed.searchParams.get("code_verifier")).toBeNull();
    expect(url).not.toContain("client_secret");
    expect(url).not.toContain(verifier);
    const body = googleTokenRequest({
      clientId: CLIENT,
      redirectUri: "http://127.0.0.1:42813/callback",
      code: "auth-code",
      codeVerifier: verifier,
    }).body;
    expect(body).toContain("code_verifier=");
    expect(body).toContain("grant_type=authorization_code");
    expect(body).not.toContain("client_secret");
    const refresh = googleTokenRequest({ clientId: CLIENT, refreshToken: "1//refresh-token" }).body;
    expect(refresh).toContain("grant_type=refresh_token");
    expect(refresh).not.toContain("code_verifier");
  });

  it("parses token, drive, and calendar payloads", () => {
    expect(parseGoogleTokenResponse({ access_token: "ya29.access", expires_in: 10, refresh_token: "1//refresh" }, 1_000)).toEqual({
      accessToken: "ya29.access",
      expiresAt: 11_000,
      refreshToken: "1//refresh",
    });
    expect(parseGoogleTokenResponse({ expires_in: 10 }, 0)).toBeNull();
    expect(parseDriveFiles({
      files: [
        { id: "f1", name: "보고서.pdf", mimeType: "application/pdf", modifiedTime: "2026-10-24T00:00:00.000Z" },
        { id: 1, name: "skip" },
      ],
    }, 8)).toEqual([
      { id: "f1", name: "보고서.pdf", mimeType: "application/pdf", modifiedTime: "2026-10-24T00:00:00.000Z" },
    ]);
    expect(parseCalendarEvents({
      items: [{ summary: "스탠드업", start: { dateTime: "2026-10-24T10:00:00+09:00" }, end: { dateTime: "2026-10-24T10:30:00+09:00" }, location: "3층" }],
    })).toEqual([
      { summary: "스탠드업", start: "2026-10-24T10:00:00+09:00", end: "2026-10-24T10:30:00+09:00", allDay: false, location: "3층" },
    ]);
    const day = localDayRange(new Date(2026, 9, 24, 15, 0, 0));
    expect(new Date(day.timeMax).getTime() - new Date(day.timeMin).getTime()).toBe(24 * 60 * 60 * 1000);
    expect(driveListUrl("a'b", 8)).toContain("a%5C%27b");
    expect(calendarTodayUrl(day)).toContain("singleEvents=true");
  });

  it("keeps refresh tokens out of the status the renderer sees", () => {
    const stored = putToken(emptyTokenFile(), 7, "google-drive", {
      refreshToken: "1//super-secret-refresh",
      accessToken: "ya29.access-token",
      expiresAt: 9,
      account: "scott@ubion.co.kr",
    });
    const status = JSON.stringify(tokenStatus(stored, 7));
    expect(status).toContain("scott@ubion.co.kr");
    expect(status).not.toContain("super-secret-refresh");
    expect(status).not.toContain("ya29");
    expect(tokenStatus(dropToken(stored, 7, "google-drive"), 7).find((item) => item.id === "google-drive")?.connected).toBe(false);
    const round = parseTokenFile(serializeTokenFile(stored));
    expect(round.byUser["7"]?.["google-drive"]?.refreshToken).toBe("1//super-secret-refresh");
    expect(parseTokenFile("{")).toEqual(emptyTokenFile());
  });

  it("loads a client id from env or a local file and rejects the example placeholder", () => {
    expect(cleanClientId("YOUR_CLIENT_ID.apps.googleusercontent.com")).toBeNull();
    expect(resolveGoogleClientConfig({
      envClientId: CLIENT,
      fileText: JSON.stringify({ clientId: "9999999999-file.apps.googleusercontent.com", clientSecret: "local-secret" }),
    })).toEqual({ clientId: CLIENT, clientSecret: "local-secret" });
    expect(resolveGoogleClientConfig({
      fileText: JSON.stringify({ clientId: "YOUR_CLIENT_ID.apps.googleusercontent.com", clientSecret: "optional-do-not-commit" }),
    })).toBeNull();
    const example = readFileSync(fileURLToPath(new URL("../google-oauth.example.json", import.meta.url)), "utf8");
    expect(example).toContain("YOUR_CLIENT_ID");
    expect(resolveGoogleClientConfig({ fileText: example })).toBeNull();
    const doc = readFileSync(fileURLToPath(new URL("../docs/google-connectors.md", import.meta.url)), "utf8");
    expect(doc).toContain("https://www.googleapis.com/auth/drive.readonly");
    expect(doc).toContain("drive.metadata.readonly");
    expect(doc).toContain("google_drive_read");
    expect(doc).toContain("does not create, edit, delete, move, or share");
    expect(doc).not.toContain("files.delete");
    expect(doc).toContain("calendar.readonly");
    expect(doc).toContain("google-oauth.json");
    expect(doc).toContain("UBM_GOOGLE_CLIENT_ID");
    expect(doc).toContain("http://127.0.0.1");
    expect(doc).toContain("safeStorage");
  });

  it("captures one loopback code and does not echo it", async () => {
    const loop = await openOAuthLoopback("expected-state-value", 2000);
    const ok = await fetch(`${loop.redirectUri}?code=auth-code-1&state=expected-state-value`);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("연결되었습니다");
    expect(html).not.toContain("auth-code-1");
    await expect(loop.done).resolves.toBe("auth-code-1");
    loop.close();

    const denied = await openOAuthLoopback("expected-state-value", 2000);
    const pending = expect(denied.done).rejects.toThrow("취소");
    const bad = await fetch(`${denied.redirectUri}?error=access_denied&state=expected-state-value`);
    expect(bad.status).toBe(400);
    await pending;
    denied.close();
  });

  it("accepts a Google authorization code that contains a slash", async () => {
    expect(isGoogleAuthCode("4/P7q7W91a-oMsCeLvIaQm6bTrgtp7")).toBe(true);
    expect(isGoogleAuthCode("short")).toBe(false);
    expect(isGoogleAuthCode("4/has space")).toBe(false);
    const code = "4/0A-P7q7W91a.oMsCeLv_~+xyz";
    const loop = await openOAuthLoopback("expected-state-value", 2000);
    const ok = await rawGet(loop.redirectUri, `code=${encodeURIComponent(code)}&state=expected-state-value`);
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("연결되었습니다");
    expect(ok.body).not.toContain(code);
    expect(ok.body).not.toContain("4/0A");
    await expect(loop.done).resolves.toBe(code);
    loop.close();

    const plus = await openOAuthLoopback("expected-state-value", 2000);
    const plusRes = await rawGet(plus.redirectUri, "code=4%2F0Aabc+def&state=expected-state-value");
    expect(plusRes.status).toBe(200);
    await expect(plus.done).resolves.toBe("4/0Aabc+def");
    plus.close();
  });

  it("turns Google callback errors into distinct Korean hints without secrets", async () => {
    const testing = "The developer has not given you access. It is currently being tested and it has not been verified by Google. code=4/0ASECRETCODE ya29.SUPERSECRETTOKEN";
    expect(oauthCallbackMessage("access_denied", testing)).toContain("취소");
    expect(oauthCallbackMessage("access_denied", testing)).toContain("cwdaddy@gmail.com");
    expect(oauthCallbackMessage("access_denied", testing)).toContain("edtechnewsroom@gmail.com");
    expect(oauthCallbackMessage("access_denied", testing)).toContain("access_denied");
    expect(oauthCallbackMessage("access_denied", testing)).not.toContain("4/0A");
    expect(oauthCallbackMessage("access_denied", testing)).not.toContain("ya29");
    expect(oauthCallbackMessage("access_denied", "The user did not consent")).not.toContain("cwdaddy");
    expect(oauthCallbackMessage("redirect_uri_mismatch", "Bad redirect")).toContain("리다이렉트");
    expect(oauthCallbackMessage("invalid_client", "Unauthorized")).toContain("google-oauth.json");
    expect(oauthCallbackMessage("server_error", "temporarily down")).toContain("server_error");
    const unsafe = oauthCallbackMessage("not a code", "x");
    expect(unsafe).toContain("unknown: x");
    expect(unsafe).not.toContain("not a code");

    const loop = await openOAuthLoopback("expected-state-value", 2000);
    const failed = loop.done.then(() => { throw new Error("expected reject"); }, (err: unknown) => err);
    const res = await rawGet(loop.redirectUri, `error=access_denied&error_description=${encodeURIComponent(testing)}&state=expected-state-value`);
    expect(res.status).toBe(400);
    expect(res.body).toContain("cwdaddy@gmail.com");
    expect(res.body).not.toContain("<script>");
    expect(res.body).not.toContain("4/0A");
    expect(res.body).not.toContain("ya29");
    const err = await failed;
    expect(err).toBeInstanceOf(GoogleConnectError);
    expect((err as GoogleConnectError).oauthError).toBe("access_denied");
    expect((err as Error).message).toContain("edtechnewsroom@gmail.com");
    loop.close();

    const mismatch = await openOAuthLoopback("expected-state-value", 2000);
    const mismatchErr = mismatch.done.then(() => { throw new Error("expected reject"); }, (e: unknown) => e);
    const page = await rawGet(mismatch.redirectUri, "error=redirect_uri_mismatch&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    expect(page.body).toContain("리다이렉트");
    expect(page.body).toContain("&lt;script&gt;");
    expect(page.body).not.toContain("<script>");
    expect((await mismatchErr as GoogleConnectError).oauthError).toBe("redirect_uri_mismatch");
    mismatch.close();
  });

  it("writes only the error code to the debug log", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ubm-oauth-"));
    const file = path.join(dir, "google-oauth-debug.log");
    try {
      appendGoogleOAuthDebugLog(file, "invalid_client");
      appendGoogleOAuthDebugLog(file, "access_denied ya29.SHOULD_NOT_APPEAR 4/0Asecret");
      const text = readFileSync(file, "utf8");
      expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z invalid_client\n/);
      expect(text).toContain("unknown");
      expect(text).not.toContain("ya29");
      expect(text).not.toContain("4/0A");
      expect(text).not.toContain("SHOULD");
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("google connector host", () => {
  it("connects, lists, refreshes, and never writes the refresh token into connector prefs", async () => {
    let file: GoogleTokenFile = emptyTokenFile();
    let now = 1_000_000;
    const calls: { url: string; body?: string; auth?: string }[] = [];
    const fetchImpl: GoogleFetch = async (url, init) => {
      calls.push({ url, body: init?.body, auth: init?.headers?.Authorization });
      if (url.includes("oauth2.googleapis.com/token")) {
        const body = init?.body || "";
        if (body.includes("grant_type=refresh_token")) {
          return jsonResponse(200, { access_token: "ya29.refreshed", expires_in: 3600 });
        }
        return jsonResponse(200, { access_token: "ya29.access", expires_in: 3600, refresh_token: "1//refresh-token", scope: GOOGLE_DRIVE_SCOPE });
      }
      if (url.includes("/drive/v3/about")) return jsonResponse(200, { user: { emailAddress: "scott@ubion.co.kr" } });
      if (url.includes("/drive/v3/files")) {
        return jsonResponse(200, { files: [{ id: "f1", name: "보고서.pdf", mimeType: "application/pdf" }] });
      }
      throw new Error(url);
    };
    const host = new GoogleConnectorHost({
      config: () => ({ clientId: CLIENT }),
      read: () => file,
      write: (next) => { file = next; },
      openBrowser: async (url) => {
        expect(url).toContain(encodeURIComponent(GOOGLE_DRIVE_SCOPE));
        expect(url).not.toContain("client_secret");
      },
      fetchImpl,
      now: () => now,
      loopback: async () => ({ redirectUri: "http://127.0.0.1:9/callback", done: Promise.resolve("auth-code-1"), close() {} }),
    });

    await expect(host.connect(7, "google-drive")).resolves.toEqual({ connected: true, account: "scott@ubion.co.kr" });
    expect(host.status(7).connectors.find((item) => item.id === "google-drive")).toEqual({
      id: "google-drive",
      connected: true,
      account: "scott@ubion.co.kr",
    });
    const prefs: ConnectorPrefs = { "google-drive": { enabled: true } };
    const resolved = resolveConnectors(prefs, undefined, { "google-drive": true });
    expect(advertisedTools(resolved).map((tool) => tool.name)).toEqual(expect.arrayContaining(["google_drive_list", "google_drive_read"]));
    const store = { saved: "" };
    saveConnectorPrefs({ setItem: (_k, v) => { store.saved = v; } }, 7, prefs);
    expect(store.saved).not.toContain("refresh-token");
    expect(store.saved).not.toContain("ya29");

    const listed = await host.driveList(7, { query: "보고서", limit: 5 });
    expect(listed).toEqual({ ok: true, files: [{ id: "f1", name: "보고서.pdf", mimeType: "application/pdf" }] });
    expect(calls.some((call) => call.auth === "Bearer ya29.access")).toBe(true);

    now = file.byUser["7"]!["google-drive"]!.expiresAt;
    const again = await host.driveList(7, {});
    expect(again.ok).toBe(true);
    const refresh = calls.find((call) => call.body?.includes("grant_type=refresh_token"));
    expect(refresh?.body).toContain("refresh_token=1%2F%2Frefresh-token");
    expect(refresh?.body).not.toContain("ya29");
    expect(refresh?.body).not.toContain("client_secret");
    expect(calls.some((call) => call.body?.includes("grant_type=authorization_code") && !call.body.includes("client_secret"))).toBe(true);
    expect(calls.some((call) => call.auth === "Bearer ya29.refreshed")).toBe(true);

    expect(host.disconnect(7, "google-drive")).toEqual({ connected: false });
    expect(await host.driveList(7, {})).toMatchObject({ ok: false, code: "connect-later" });
    expect(host.status(7).connectors.every((item) => item.connected === false)).toBe(true);
  });

  it("does not open the browser when the client id is missing", async () => {
    const host = new GoogleConnectorHost({
      config: () => null,
      read: () => emptyTokenFile(),
      write: () => { throw new Error("should not store"); },
      openBrowser: async () => { throw new Error("should not open"); },
      fetchImpl: async () => { throw new Error("should not fetch"); },
      loopback: async () => { throw new Error("should not listen"); },
    });
    await expect(host.connect(7, "google-calendar")).rejects.toThrow("UBM_GOOGLE_CLIENT_ID");
  });

  it("surfaces the token endpoint error and logs only that code", async () => {
    const logged: string[] = [];
    let body = "";
    const host = new GoogleConnectorHost({
      config: () => ({ clientId: CLIENT, clientSecret: "local-only-secret" }),
      read: () => emptyTokenFile(),
      write: () => { throw new Error("should not store"); },
      openBrowser: async () => {},
      fetchImpl: async (_url, init) => {
        body = init?.body || "";
        return jsonResponse(401, {
          error: "invalid_client",
          error_description: "The OAuth client was not found. client_secret=GOCSPX-supersecretvalue",
        });
      },
      loopback: async () => ({
        redirectUri: "http://127.0.0.1:9/callback",
        done: Promise.resolve("4/0A-auth-code"),
        close() {},
      }),
      debugLog: (code) => logged.push(code),
    });
    let caught: Error | undefined;
    try {
      await host.connect(7, "google-calendar");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toContain("Google 토큰을 받지 못했습니다.");
    expect(caught?.message).toContain("클라이언트 ID 또는 비밀번호를 확인해 주세요.");
    expect(caught?.message).toContain("invalid_client");
    expect(caught?.message).toContain("The OAuth client was not found.");
    expect(caught?.message).not.toContain("GOCSPX");
    expect(caught?.message).not.toContain("local-only-secret");
    expect(caught?.message).not.toContain("4/0A");
    expect(body).toContain("client_secret=local-only-secret");
    expect(body).toContain("code=4%2F0A-auth-code");
    expect(logged).toEqual(["invalid_client"]);
    expect(JSON.stringify(logged)).not.toContain("local-only-secret");
    expect(JSON.stringify(logged)).not.toContain("4/0A");
    expect(oauthTokenFailureMessage({ error: "redirect_uri_mismatch", error_description: "mismatch" })).toContain("리다이렉트");
    expect(oauthTokenFailureMessage(null)).toBe("Google 토큰을 받지 못했습니다.");
  });

  it("logs access_denied from the callback and keeps the cancel wording", async () => {
    const logged: string[] = [];
    const message = oauthCallbackMessage("access_denied", "currently being tested and hasn't been verified");
    const done = Promise.reject(new GoogleConnectError(message, "access_denied"));
    done.catch(() => {});
    const host = new GoogleConnectorHost({
      config: () => ({ clientId: CLIENT }),
      read: () => emptyTokenFile(),
      write: () => { throw new Error("should not store"); },
      openBrowser: async () => {},
      fetchImpl: async () => { throw new Error("should not fetch"); },
      loopback: async () => ({ redirectUri: "http://127.0.0.1:9/callback", done, close() {} }),
      debugLog: (code) => logged.push(code),
    });
    await expect(host.connect(7, "google-drive")).rejects.toThrow(/취소/);
    expect(logged).toEqual(["access_denied"]);
    expect(message).toContain("cwdaddy@gmail.com");
  });
});
