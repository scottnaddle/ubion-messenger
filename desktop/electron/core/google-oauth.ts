/**
 * Google OAuth for 내 봇 (desktop public client).
 * PKCE + loopback. No client secret in this module. Tokens are not logged.
 */
import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export const GOOGLE_CONNECTOR_IDS = ["google-drive", "google-calendar"] as const;
export type GoogleConnectorId = (typeof GOOGLE_CONNECTOR_IDS)[number];

export function isGoogleConnectorId(id: unknown): id is GoogleConnectorId {
  return id === "google-drive" || id === "google-calendar";
}

export function scopeFor(id: GoogleConnectorId): string {
  return id === "google-drive" ? GOOGLE_DRIVE_SCOPE : GOOGLE_CALENDAR_SCOPE;
}

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,}\.apps\.googleusercontent\.com$/;

export function cleanClientId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!CLIENT_ID_RE.test(id)) return null;
  if (/your_|replace|example|placeholder/i.test(id)) return null;
  return id;
}

export function cleanClientSecret(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const secret = value.trim();
  if (!secret || secret.length > 256 || /[\r\n]/.test(secret)) return undefined;
  if (/^your_|optional|replace|do-not-commit|placeholder/i.test(secret)) return undefined;
  return secret;
}

export function resolveGoogleClientConfig(input: {
  envClientId?: string | null;
  envClientSecret?: string | null;
  fileText?: string | null;
}): { clientId: string; clientSecret?: string } | null {
  let fileId: string | null = null;
  let fileSecret: string | undefined;
  if (input.fileText && input.fileText.trim()) {
    try {
      const parsed = JSON.parse(input.fileText) as { clientId?: unknown; clientSecret?: unknown };
      fileId = cleanClientId(parsed.clientId);
      fileSecret = cleanClientSecret(parsed.clientSecret);
    } catch {
      fileId = null;
    }
  }
  const clientId = cleanClientId(input.envClientId) || fileId;
  if (!clientId) return null;
  const clientSecret = cleanClientSecret(input.envClientSecret) || fileSecret;
  return clientSecret ? { clientId, clientSecret } : { clientId };
}

export function createPkce(bytes: Buffer = randomBytes(32)): { verifier: string; challenge: string } {
  const verifier = bytes.toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function createOAuthState(bytes: Buffer = randomBytes(32)): string {
  return bytes.toString("base64url");
}

export function googleAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", opts.scope);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  return url.toString();
}

export function googleTokenRequest(opts: {
  clientId: string;
  clientSecret?: string;
  redirectUri?: string;
  code?: string;
  codeVerifier?: string;
  refreshToken?: string;
}): { url: string; body: string } {
  const params = new URLSearchParams();
  params.set("client_id", opts.clientId);
  if (opts.clientSecret) params.set("client_secret", opts.clientSecret);
  if (opts.refreshToken) {
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", opts.refreshToken);
  } else {
    params.set("grant_type", "authorization_code");
    params.set("code", opts.code || "");
    params.set("redirect_uri", opts.redirectUri || "");
    params.set("code_verifier", opts.codeVerifier || "");
  }
  return { url: GOOGLE_TOKEN_URL, body: params.toString() };
}

export function parseGoogleTokenResponse(payload: unknown, now: number): {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  scope?: string;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; scope?: unknown };
  if (typeof data.access_token !== "string" || data.access_token.length < 8 || data.access_token.length > 4096) return null;
  const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0
    ? data.expires_in
    : 3600;
  const refreshToken = typeof data.refresh_token === "string" && data.refresh_token.length >= 8 && data.refresh_token.length <= 2048
    ? data.refresh_token
    : undefined;
  const scope = typeof data.scope === "string" ? data.scope.slice(0, 500) : undefined;
  return {
    accessToken: data.access_token,
    expiresAt: now + expiresIn * 1000,
    ...(refreshToken ? { refreshToken } : {}),
    ...(scope ? { scope } : {}),
  };
}

export function isInvalidGrant(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as { error?: unknown }).error === "invalid_grant";
}

export function clipLimit(value: unknown, fallback = 8, max = 8): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

export function driveListUrl(query: string, limit: number): string {
  const name = query.trim().slice(0, 100).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q = name ? `trashed = false and name contains '${name}'` : "trashed = false";
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("pageSize", String(limit));
  url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime)");
  url.searchParams.set("orderBy", "modifiedTime desc");
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("q", q);
  return url.toString();
}

export type DriveFileItem = { id: string; name: string; mimeType: string; modifiedTime?: string };

export function parseDriveFiles(payload: unknown, limit: number): DriveFileItem[] {
  const files = payload && typeof payload === "object" ? (payload as { files?: unknown }).files : null;
  if (!Array.isArray(files)) return [];
  const out: DriveFileItem[] = [];
  for (const item of files) {
    if (!item || typeof item !== "object") continue;
    const row = item as { id?: unknown; name?: unknown; mimeType?: unknown; modifiedTime?: unknown };
    if (typeof row.id !== "string" || typeof row.name !== "string") continue;
    out.push({
      id: row.id.slice(0, 200),
      name: row.name.slice(0, 180),
      mimeType: typeof row.mimeType === "string" ? row.mimeType.slice(0, 120) : "",
      ...(typeof row.modifiedTime === "string" ? { modifiedTime: row.modifiedTime.slice(0, 40) } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function parseDriveAccount(payload: unknown): string | undefined {
  const email = payload && typeof payload === "object"
    ? (payload as { user?: { emailAddress?: unknown } }).user?.emailAddress
    : undefined;
  return typeof email === "string" && email.includes("@") && email.length <= 200 ? email : undefined;
}

export function localDayRange(now: Date): { timeMin: string; timeMax: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

export function calendarTodayUrl(range: { timeMin: string; timeMax: string }): string {
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", range.timeMin);
  url.searchParams.set("timeMax", range.timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "12");
  url.searchParams.set("fields", "items(summary,location,start,end)");
  return url.toString();
}

export type CalendarEventItem = { summary: string; start: string; end: string; allDay: boolean; location: string };

export function parseCalendarEvents(payload: unknown): CalendarEventItem[] {
  const items = payload && typeof payload === "object" ? (payload as { items?: unknown }).items : null;
  if (!Array.isArray(items)) return [];
  const out: CalendarEventItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as {
      summary?: unknown;
      location?: unknown;
      start?: { dateTime?: unknown; date?: unknown };
      end?: { dateTime?: unknown; date?: unknown };
    };
    const startDateTime = typeof row.start?.dateTime === "string" ? row.start.dateTime : "";
    const startDate = typeof row.start?.date === "string" ? row.start.date : "";
    const endDateTime = typeof row.end?.dateTime === "string" ? row.end.dateTime : "";
    const endDate = typeof row.end?.date === "string" ? row.end.date : "";
    const start = (startDateTime || startDate).slice(0, 40);
    if (!start) continue;
    out.push({
      summary: typeof row.summary === "string" ? row.summary.slice(0, 180) : "(제목 없음)",
      start,
      end: (endDateTime || endDate).slice(0, 40),
      allDay: !startDateTime && !!startDate,
      location: typeof row.location === "string" ? row.location.slice(0, 80) : "",
    });
    if (out.length >= 12) break;
  }
  return out;
}

export function parseCalendarAccount(payload: unknown): string | undefined {
  const id = payload && typeof payload === "object" ? (payload as { id?: unknown }).id : undefined;
  return typeof id === "string" && id.includes("@") && id.length <= 200 ? id : undefined;
}

export type GoogleTokenRecord = {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  account?: string;
  scope?: string;
};

export type GoogleTokenFile = {
  v: 1;
  byUser: Record<string, Partial<Record<GoogleConnectorId, GoogleTokenRecord>>>;
};

export function emptyTokenFile(): GoogleTokenFile {
  return { v: 1, byUser: {} };
}

function cleanRecord(value: unknown): GoogleTokenRecord | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Partial<GoogleTokenRecord>;
  if (typeof rec.refreshToken !== "string" || rec.refreshToken.length < 8 || rec.refreshToken.length > 2048) return null;
  if (typeof rec.accessToken !== "string" || rec.accessToken.length < 8 || rec.accessToken.length > 4096) return null;
  if (typeof rec.expiresAt !== "number" || !Number.isFinite(rec.expiresAt)) return null;
  const account = typeof rec.account === "string" && rec.account.length <= 200 ? rec.account : undefined;
  const scope = typeof rec.scope === "string" && rec.scope.length <= 500 ? rec.scope : undefined;
  return {
    refreshToken: rec.refreshToken,
    accessToken: rec.accessToken,
    expiresAt: rec.expiresAt,
    ...(account ? { account } : {}),
    ...(scope ? { scope } : {}),
  };
}

export function parseTokenFile(raw: string): GoogleTokenFile {
  try {
    const data = JSON.parse(raw) as { v?: unknown; byUser?: unknown };
    if (data.v !== 1 || !data.byUser || typeof data.byUser !== "object" || Array.isArray(data.byUser)) return emptyTokenFile();
    const byUser: GoogleTokenFile["byUser"] = {};
    for (const [userId, bag] of Object.entries(data.byUser)) {
      if (!/^[1-9]\d*$/.test(userId) || !bag || typeof bag !== "object") continue;
      const next: Partial<Record<GoogleConnectorId, GoogleTokenRecord>> = {};
      for (const id of GOOGLE_CONNECTOR_IDS) {
        const rec = cleanRecord((bag as Record<string, unknown>)[id]);
        if (rec) next[id] = rec;
      }
      if (Object.keys(next).length) byUser[userId] = next;
    }
    return { v: 1, byUser };
  } catch {
    return emptyTokenFile();
  }
}

export function serializeTokenFile(file: GoogleTokenFile): string {
  return JSON.stringify(file);
}

export type GoogleLinkStatus = { id: GoogleConnectorId; connected: boolean; account?: string };

export function tokenStatus(file: GoogleTokenFile, userId: number): GoogleLinkStatus[] {
  const bag = file.byUser[String(userId)] ?? {};
  return GOOGLE_CONNECTOR_IDS.map((id) => {
    const rec = bag[id];
    return rec ? { id, connected: true, ...(rec.account ? { account: rec.account } : {}) } : { id, connected: false };
  });
}

export function readToken(file: GoogleTokenFile, userId: number, id: GoogleConnectorId): GoogleTokenRecord | null {
  return file.byUser[String(userId)]?.[id] ?? null;
}

export function putToken(file: GoogleTokenFile, userId: number, id: GoogleConnectorId, record: GoogleTokenRecord): GoogleTokenFile {
  const key = String(userId);
  return {
    v: 1,
    byUser: {
      ...file.byUser,
      [key]: { ...file.byUser[key], [id]: record },
    },
  };
}

export function dropToken(file: GoogleTokenFile, userId: number, id: GoogleConnectorId): GoogleTokenFile {
  const key = String(userId);
  const bag = { ...file.byUser[key] };
  delete bag[id];
  const byUser = { ...file.byUser };
  if (Object.keys(bag).length) byUser[key] = bag;
  else delete byUser[key];
  return { v: 1, byUser };
}

const SUCCESS_HTML = "<!doctype html><meta charset=\"utf-8\"><title>UBION</title><p>연결되었습니다. 이 창을 닫아도 됩니다.</p>";
const FAIL_HTML = "<!doctype html><meta charset=\"utf-8\"><title>UBION</title><p>연결하지 못했습니다. 메신저로 돌아가 주세요.</p>";

export type OAuthLoopback = {
  redirectUri: string;
  done: Promise<string>;
  close: () => void;
};

function sameState(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/** Bind 127.0.0.1 on a free port and capture one /callback code. */
export function openOAuthLoopback(expectedState: string, timeoutMs = 180_000): Promise<OAuthLoopback> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let finish!: (code: string) => void;
    let fail!: (error: Error) => void;
    const done = new Promise<string>((res, rej) => {
      finish = res;
      fail = rej;
    });
    const server = http.createServer((req, res) => {
      let url: URL;
      try {
        url = new URL(req.url || "/", "http://127.0.0.1");
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("bad request");
        return;
      }
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      const write = (status: number, html: string) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
      };
      if (settled) {
        write(409, FAIL_HTML);
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code") || "";
      const state = url.searchParams.get("state") || "";
      settled = true;
      clearTimeout(timer);
      if (error) {
        write(400, FAIL_HTML);
        fail(new Error(error === "access_denied" ? "Google 연결이 취소되었습니다." : "Google 연결을 확인하지 못했습니다."));
        return;
      }
      if (!sameState(state, expectedState) || !/^[A-Za-z0-9._~-]{8,512}$/.test(code)) {
        write(400, FAIL_HTML);
        fail(new Error("Google 연결을 확인하지 못했습니다."));
        return;
      }
      write(200, SUCCESS_HTML);
      finish(code);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      fail(new Error("Google 연결 시간이 초과되었습니다."));
      server.close();
    }, timeoutMs);
    timer.unref?.();
    server.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr || typeof addr === "string") {
        settled = true;
        clearTimeout(timer);
        reject(new Error("Google 연결을 확인하지 못했습니다."));
        return;
      }
      resolve({
        redirectUri: `http://127.0.0.1:${addr.port}/callback`,
        done,
        close: () => {
          clearTimeout(timer);
          server.close();
        },
      });
    });
  });
}
