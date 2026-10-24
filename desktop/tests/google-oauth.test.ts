import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
  calendarTodayUrl,
  cleanClientId,
  createPkce,
  driveListUrl,
  dropToken,
  emptyTokenFile,
  googleAuthorizeUrl,
  googleTokenRequest,
  localDayRange,
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
    expect(parsed.searchParams.get("scope")).toBe(GOOGLE_DRIVE_SCOPE);
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
    expect(doc).toContain("drive.metadata.readonly");
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
    expect(advertisedTools(resolved).map((tool) => tool.name)).toContain("google_drive_list");
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
});
