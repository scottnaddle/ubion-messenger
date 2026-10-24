/**
 * Connect / refresh / read for Google Drive and Calendar.
 * The proxy never sees these tokens. Persistence is injected (safeStorage in main).
 */
import {
  calendarTodayUrl,
  clipLimit,
  driveListUrl,
  dropToken,
  googleAuthorizeUrl,
  googleTokenRequest,
  isGoogleConnectorId,
  isInvalidGrant,
  localDayRange,
  openOAuthLoopback,
  parseCalendarAccount,
  parseCalendarEvents,
  parseDriveAccount,
  parseDriveFiles,
  parseGoogleTokenResponse,
  putToken,
  readToken,
  scopeFor,
  tokenStatus,
  createOAuthState,
  createPkce,
  type GoogleConnectorId,
  type GoogleLinkStatus,
  type GoogleTokenFile,
  type GoogleTokenRecord,
  type OAuthLoopback,
  type CalendarEventItem,
  type DriveFileItem,
} from "./google-oauth";

export type GoogleFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  status: number;
  json: () => Promise<unknown>;
}>;

export type GoogleClientConfig = { clientId: string; clientSecret?: string };

export type GoogleToolResult =
  | { ok: true; files: DriveFileItem[] }
  | { ok: true; items: CalendarEventItem[] }
  | { ok: false; code: string; message: string };

const MISSING_CLIENT = "Google 클라이언트 ID가 없습니다. google-oauth.json 또는 UBM_GOOGLE_CLIENT_ID를 설정하세요.";
const TOKEN_FAILED = "Google 토큰을 받지 못했습니다.";
const NO_REFRESH = "Google이 갱신 토큰을 주지 않았습니다. 연결을 다시 시도해 주세요.";
const LIST_FAILED = "Google에서 목록을 가져오지 못했습니다.";
const REVOKED = "Google 접근 권한이 없습니다. 다시 연결해 주세요.";

function laterMessage(id: GoogleConnectorId): string {
  return id === "google-drive" ? "Google Drive는 아직 연결 전입니다." : "Google Calendar는 아직 연결 전입니다.";
}

export class GoogleConnectorHost {
  private flight: Promise<unknown> | null = null;

  constructor(private readonly deps: {
    config: () => GoogleClientConfig | null;
    read: () => GoogleTokenFile;
    write: (file: GoogleTokenFile) => void;
    openBrowser: (url: string) => Promise<void> | void;
    fetchImpl: GoogleFetch;
    now?: () => number;
    loopback?: (state: string) => Promise<OAuthLoopback>;
    pkce?: () => { verifier: string; challenge: string; state: string };
  }) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  status(userId: number): { connectors: GoogleLinkStatus[] } {
    this.assertUser(userId);
    return { connectors: tokenStatus(this.deps.read(), userId) };
  }

  async connect(userId: number, id: GoogleConnectorId): Promise<{ connected: true; account?: string }> {
    this.assertUser(userId);
    if (!isGoogleConnectorId(id)) throw new Error("알 수 없는 Google 연결입니다.");
    if (this.flight) throw new Error("Google 연결이 이미 진행 중입니다.");
    const run = this.connectInner(userId, id);
    this.flight = run;
    try {
      return await run;
    } finally {
      this.flight = null;
    }
  }

  disconnect(userId: number, id: GoogleConnectorId): { connected: false } {
    this.assertUser(userId);
    if (!isGoogleConnectorId(id)) throw new Error("알 수 없는 Google 연결입니다.");
    this.deps.write(dropToken(this.deps.read(), userId, id));
    return { connected: false };
  }

  async driveList(userId: number, args: { query?: unknown; limit?: unknown } = {}): Promise<GoogleToolResult> {
    this.assertUser(userId);
    const access = await this.ensureAccess(userId, "google-drive");
    if ("error" in access) return access.error;
    const limit = clipLimit(args.limit);
    const query = typeof args.query === "string" ? args.query : "";
    const got = await this.getJson(driveListUrl(query, limit), access.token);
    if (!got) return { ok: false, code: "network", message: LIST_FAILED };
    if (got.status === 401 || got.status === 403) return { ok: false, code: "revoked", message: REVOKED };
    if (got.status !== 200) return { ok: false, code: "google", message: LIST_FAILED };
    return { ok: true, files: parseDriveFiles(got.json, limit) };
  }

  async calendarToday(userId: number): Promise<GoogleToolResult> {
    this.assertUser(userId);
    const access = await this.ensureAccess(userId, "google-calendar");
    if ("error" in access) return access.error;
    const got = await this.getJson(calendarTodayUrl(localDayRange(new Date(this.now()))), access.token);
    if (!got) return { ok: false, code: "network", message: LIST_FAILED };
    if (got.status === 401 || got.status === 403) return { ok: false, code: "revoked", message: REVOKED };
    if (got.status !== 200) return { ok: false, code: "google", message: LIST_FAILED };
    return { ok: true, items: parseCalendarEvents(got.json) };
  }

  private assertUser(userId: number): void {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("사용자를 확인하지 못했습니다.");
  }

  private async connectInner(userId: number, id: GoogleConnectorId): Promise<{ connected: true; account?: string }> {
    const config = this.deps.config();
    if (!config) throw new Error(MISSING_CLIENT);
    const pkce = this.deps.pkce ? this.deps.pkce() : { ...createPkce(), state: createOAuthState() };
    const loop = await (this.deps.loopback ?? openOAuthLoopback)(pkce.state);
    try {
      const url = googleAuthorizeUrl({
        clientId: config.clientId,
        redirectUri: loop.redirectUri,
        scope: scopeFor(id),
        state: pkce.state,
        codeChallenge: pkce.challenge,
      });
      await this.deps.openBrowser(url);
      const code = await loop.done;
      const exchanged = await this.exchange(config, loop.redirectUri, code, pkce.verifier);
      if (!exchanged.refreshToken) throw new Error(NO_REFRESH);
      const account = await this.lookupAccount(id, exchanged.accessToken);
      const record: GoogleTokenRecord = {
        refreshToken: exchanged.refreshToken,
        accessToken: exchanged.accessToken,
        expiresAt: exchanged.expiresAt,
        ...(exchanged.scope ? { scope: exchanged.scope } : {}),
        ...(account ? { account } : {}),
      };
      this.deps.write(putToken(this.deps.read(), userId, id, record));
      return account ? { connected: true, account } : { connected: true };
    } finally {
      loop.close();
    }
  }

  private async exchange(config: GoogleClientConfig, redirectUri: string, code: string, verifier: string) {
    const req = googleTokenRequest({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri,
      code,
      codeVerifier: verifier,
    });
    const got = await this.post(req.url, req.body);
    if (!got || got.status !== 200) throw new Error(TOKEN_FAILED);
    const parsed = parseGoogleTokenResponse(got.json, this.now());
    if (!parsed) throw new Error(TOKEN_FAILED);
    return parsed;
  }

  private async ensureAccess(userId: number, id: GoogleConnectorId): Promise<{ token: string } | { error: Extract<GoogleToolResult, { ok: false }> }> {
    const current = readToken(this.deps.read(), userId, id);
    if (!current) return { error: { ok: false, code: "connect-later", message: laterMessage(id) } };
    if (current.expiresAt - 60_000 > this.now()) return { token: current.accessToken };
    const config = this.deps.config();
    if (!config) return { error: { ok: false, code: "config", message: MISSING_CLIENT } };
    const req = googleTokenRequest({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: current.refreshToken,
    });
    const got = await this.post(req.url, req.body);
    if (!got) return { error: { ok: false, code: "network", message: LIST_FAILED } };
    if (got.status === 400 && isInvalidGrant(got.json)) {
      this.deps.write(dropToken(this.deps.read(), userId, id));
      return { error: { ok: false, code: "revoked", message: REVOKED } };
    }
    const parsed = got.status === 200 ? parseGoogleTokenResponse(got.json, this.now()) : null;
    if (!parsed) return { error: { ok: false, code: "token", message: TOKEN_FAILED } };
    const record: GoogleTokenRecord = {
      ...current,
      accessToken: parsed.accessToken,
      expiresAt: parsed.expiresAt,
      refreshToken: parsed.refreshToken || current.refreshToken,
      ...(parsed.scope ? { scope: parsed.scope } : {}),
    };
    this.deps.write(putToken(this.deps.read(), userId, id, record));
    return { token: record.accessToken };
  }

  private async lookupAccount(id: GoogleConnectorId, token: string): Promise<string | undefined> {
    const url = id === "google-drive"
      ? "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)"
      : "https://www.googleapis.com/calendar/v3/calendars/primary?fields=id";
    const got = await this.getJson(url, token);
    if (!got || got.status !== 200) return undefined;
    return id === "google-drive" ? parseDriveAccount(got.json) : parseCalendarAccount(got.json);
  }

  private async post(url: string, body: string): Promise<{ status: number; json: unknown } | null> {
    try {
      const res = await this.deps.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    } catch {
      return null;
    }
  }

  private async getJson(url: string, token: string): Promise<{ status: number; json: unknown } | null> {
    try {
      const res = await this.deps.fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    } catch {
      return null;
    }
  }
}
