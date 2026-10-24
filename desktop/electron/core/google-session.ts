/**
 * Connect / refresh / read for Google Drive and Calendar.
 * The proxy never sees these tokens. Persistence is injected (safeStorage in main).
 */
import { extractPdfText } from "./drive-pdf";
import { extractDocxText, extractPptxText, extractXlsxText, htmlToText } from "./drive-text";
import {
  DRIVE_EMPTY_NOTE,
  DRIVE_MIME_ERROR,
  DRIVE_NAME_ONLY_NOTE,
  DRIVE_READ_MAX_BYTES,
  DRIVE_RECONNECT_MESSAGE,
  DRIVE_SCAN_NOTE,
  calendarTodayUrl,
  cleanDriveFileId,
  clipLimit,
  clipReadChars,
  driveExportUrl,
  driveFileMetaUrl,
  driveListUrl,
  driveMediaUrl,
  driveMimeClause,
  driveParentsUrl,
  driveScopeAllowsContent,
  dropToken,
  googleAuthorizeUrl,
  googleTokenRequest,
  isGoogleConnectorId,
  isInsufficientDriveScope,
  isInvalidGrant,
  localDayRange,
  openOAuthLoopback,
  parseCalendarAccount,
  parseCalendarEvents,
  parseDriveAccount,
  parseDriveFileMeta,
  parseDriveFiles,
  parseDriveNames,
  parseGoogleTokenResponse,
  putToken,
  readToken,
  routeDriveMime,
  scopeFor,
  tokenStatus,
  truncateDriveText,
  createOAuthState,
  createPkce,
  GoogleConnectError,
  oauthErrorCode,
  oauthTokenFailureMessage,
  type GoogleConnectorId,
  type GoogleLinkStatus,
  type GoogleTokenFile,
  type GoogleTokenRecord,
  type OAuthLoopback,
  type CalendarEventItem,
  type DriveFileItem,
  type DriveReadRoute,
} from "./google-oauth";

export type GoogleFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  status: number;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}>;

export type GoogleClientConfig = { clientId: string; clientSecret?: string };

export type GoogleToolResult =
  | { ok: true; files: DriveFileItem[]; note?: string }
  | { ok: true; items: CalendarEventItem[] }
  | { ok: true; name: string; mimeType: string; text: string; truncated?: true; note?: string }
  | { ok: false; code: string; message: string; name?: string; mimeType?: string };

const MISSING_CLIENT = "Google 클라이언트 ID가 없습니다. google-oauth.json 또는 UBM_GOOGLE_CLIENT_ID를 설정하세요.";
const TOKEN_FAILED = "Google 토큰을 받지 못했습니다.";
const NO_REFRESH = "Google이 갱신 토큰을 주지 않았습니다. 연결을 다시 시도해 주세요.";
const LIST_FAILED = "Google에서 목록을 가져오지 못했습니다.";
const READ_FAILED = "Drive 파일 내용을 읽지 못했습니다.";
const REVOKED = "Google 접근 권한이 없습니다. 다시 연결해 주세요.";
const EXTRACT_FAILED = "이 파일에서 텍스트를 추출하지 못했습니다.";
const TOO_LARGE = "파일이 너무 커서 내용을 읽지 않습니다.";

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
    /** Append-only diagnostic. Receives a sanitized error code, never a token or secret. */
    debugLog?: (code: string) => void;
    extractPdf?: (bytes: Uint8Array) => Promise<string>;
    extractOffice?: (kind: "docx" | "xlsx" | "pptx", bytes: Uint8Array) => Promise<string>;
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

  async driveList(userId: number, args: { query?: unknown; limit?: unknown; mime?: unknown; mimeType?: unknown; folderId?: unknown } = {}): Promise<GoogleToolResult> {
    this.assertUser(userId);
    const access = await this.ensureAccess(userId, "google-drive");
    if ("error" in access) return access.error;
    const limit = clipLimit(args.limit);
    const query = typeof args.query === "string" ? args.query : "";
    const mime = typeof args.mime === "string" ? args.mime : typeof args.mimeType === "string" ? args.mimeType : "";
    const mimeClause = driveMimeClause(mime);
    if (!mimeClause.ok) return { ok: false, code: "mime", message: DRIVE_MIME_ERROR };
    const folderRaw = typeof args.folderId === "string" ? args.folderId : "";
    const folderId = folderRaw.trim() ? cleanDriveFileId(folderRaw) : null;
    if (folderRaw.trim() && !folderId) return { ok: false, code: "folder", message: "폴더 ID가 올바르지 않습니다." };
    const contentSearch = driveScopeAllowsContent(readToken(this.deps.read(), userId, "google-drive")?.scope);
    const got = await this.getJson(driveListUrl(query, limit, { mime, folderId: folderId ?? undefined, contentSearch }), access.token);
    if (!got) return { ok: false, code: "network", message: LIST_FAILED };
    if (isInsufficientDriveScope(got.status, got.json)) return this.reconnectDrive(userId);
    if (got.status === 401 || got.status === 403) return { ok: false, code: "revoked", message: REVOKED };
    if (got.status !== 200) return { ok: false, code: "google", message: LIST_FAILED };
    const parsed = parseDriveFiles(got.json, limit);
    const names = await this.parentNames(userId, access.token, parsed.flatMap((file) => file.parentId ? [file.parentId] : []));
    if ("error" in names) return names.error;
    const files = parsed.map((file) => this.presentFile(file, names.names));
    const note = !contentSearch && query.trim() ? DRIVE_NAME_ONLY_NOTE : undefined;
    return note ? { ok: true, files, note } : { ok: true, files };
  }

  async driveRead(userId: number, args: { fileId?: unknown; maxChars?: unknown } = {}): Promise<GoogleToolResult> {
    this.assertUser(userId);
    if (typeof args.fileId !== "string" || !args.fileId.trim()) return { ok: false, code: "file", message: "파일 ID가 필요합니다." };
    const fileId = cleanDriveFileId(args.fileId);
    if (!fileId) return { ok: false, code: "file", message: "파일 ID가 올바르지 않습니다." };
    const maxChars = clipReadChars(args.maxChars);
    const access = await this.ensureAccess(userId, "google-drive");
    if ("error" in access) return access.error;
    if (!driveScopeAllowsContent(readToken(this.deps.read(), userId, "google-drive")?.scope)) return this.reconnectDrive(userId);
    const metaGot = await this.getJson(driveFileMetaUrl(fileId), access.token);
    if (!metaGot) return { ok: false, code: "network", message: READ_FAILED };
    if (isInsufficientDriveScope(metaGot.status, metaGot.json)) return this.reconnectDrive(userId);
    if (metaGot.status === 401) return { ok: false, code: "revoked", message: REVOKED };
    if (metaGot.status === 404) return { ok: false, code: "not-found", message: "파일을 찾지 못했습니다." };
    if (metaGot.status === 403) return { ok: false, code: "forbidden", message: "이 파일에 접근할 수 없습니다." };
    if (metaGot.status !== 200) return { ok: false, code: "google", message: READ_FAILED };
    const meta = parseDriveFileMeta(metaGot.json);
    if (!meta) return { ok: false, code: "google", message: READ_FAILED };
    const route = routeDriveMime(meta.mimeType);
    if (route.kind === "unsupported") return { ok: false, code: "unsupported", message: route.message, name: meta.name, mimeType: meta.mimeType };
    if (meta.size !== undefined && meta.size > DRIVE_READ_MAX_BYTES) return { ok: false, code: "too-large", message: TOO_LARGE, name: meta.name, mimeType: meta.mimeType };
    if (route.kind === "export") return this.exportText(userId, access.token, fileId, meta, route.exportMime, maxChars);
    const media = await this.readBody(driveMediaUrl(fileId), access.token, route.kind === "pdf" ? "application/pdf" : "application/octet-stream");
    if (!media) return { ok: false, code: "network", message: READ_FAILED };
    const denied = this.driveFailure(userId, media.status, media.json);
    if (denied) return denied;
    if (media.bytes.byteLength > DRIVE_READ_MAX_BYTES) return { ok: false, code: "too-large", message: TOO_LARGE, name: meta.name, mimeType: meta.mimeType };
    try {
      if (route.kind === "pdf") return this.textResult(meta, await (this.deps.extractPdf ?? extractPdfText)(media.bytes), maxChars, "scan");
      if (route.kind === "text") {
        const raw = new TextDecoder("utf-8", { fatal: false }).decode(media.bytes).replace(/^\uFEFF/, "");
        return this.textResult(meta, route.html ? htmlToText(raw) : raw, maxChars, "keep");
      }
      const office = await this.officeText(route.kind, media.bytes);
      return this.textResult(meta, office, maxChars, "office");
    } catch {
      return { ok: false, code: "extract", message: EXTRACT_FAILED, name: meta.name, mimeType: meta.mimeType };
    }
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

  private reconnectDrive(userId: number): Extract<GoogleToolResult, { ok: false }> {
    this.deps.write(dropToken(this.deps.read(), userId, "google-drive"));
    try {
      this.deps.debugLog?.("insufficient_scope");
    } catch {
      /* best effort */
    }
    return { ok: false, code: "reconnect", message: DRIVE_RECONNECT_MESSAGE };
  }

  private presentFile(file: { id: string; name: string; mimeType: string; modifiedTime?: string; parentId?: string }, names: Record<string, string>): DriveFileItem {
    const folder = file.parentId ? names[file.parentId] : undefined;
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}),
      ...(folder ? { folder } : {}),
    };
  }

  private async parentNames(userId: number, token: string, ids: string[]): Promise<{ names: Record<string, string> } | { error: Extract<GoogleToolResult, { ok: false }> }> {
    if (!ids.length) return { names: {} };
    const got = await this.getJson(driveParentsUrl(ids), token);
    if (!got || got.status !== 200) {
      if (got && isInsufficientDriveScope(got.status, got.json)) return { error: this.reconnectDrive(userId) };
      return { names: {} };
    }
    return { names: parseDriveNames(got.json) };
  }

  private textResult(
    meta: { name: string; mimeType: string },
    raw: string,
    maxChars: number,
    empty: "scan" | "office" | "keep",
  ): GoogleToolResult {
    const cut = truncateDriveText(raw, maxChars);
    if (!cut.text.trim()) {
      if (empty === "scan") return { ok: true, name: meta.name, mimeType: meta.mimeType, text: "", note: DRIVE_SCAN_NOTE };
      if (empty === "office") return { ok: true, name: meta.name, mimeType: meta.mimeType, text: "", note: DRIVE_EMPTY_NOTE };
      return { ok: true, name: meta.name, mimeType: meta.mimeType, text: "" };
    }
    return {
      ok: true,
      name: meta.name,
      mimeType: meta.mimeType,
      text: cut.text,
      ...(cut.truncated ? { truncated: true as const } : {}),
    };
  }

  private async officeText(kind: "docx" | "xlsx" | "pptx", bytes: Uint8Array): Promise<string> {
    if (this.deps.extractOffice) return this.deps.extractOffice(kind, bytes);
    if (kind === "docx") return extractDocxText(bytes);
    if (kind === "xlsx") return extractXlsxText(bytes);
    return extractPptxText(bytes);
  }

  private driveFailure(userId: number, status: number, payload: unknown): Extract<GoogleToolResult, { ok: false }> | null {
    if (isInsufficientDriveScope(status, payload)) return this.reconnectDrive(userId);
    if (status === 401) return { ok: false, code: "revoked", message: REVOKED };
    if (status === 404) return { ok: false, code: "not-found", message: "파일을 찾지 못했습니다." };
    if (status === 403) return { ok: false, code: "forbidden", message: "이 파일에 접근할 수 없습니다." };
    if (status !== 200) return { ok: false, code: "google", message: READ_FAILED };
    return null;
  }

  private async exportText(
    userId: number,
    token: string,
    fileId: string,
    meta: { name: string; mimeType: string },
    exportMime: Extract<DriveReadRoute, { kind: "export" }>["exportMime"],
    maxChars: number,
  ): Promise<GoogleToolResult> {
    const got = await this.readBody(driveExportUrl(fileId, exportMime), token, exportMime);
    if (!got) return { ok: false, code: "network", message: READ_FAILED };
    const denied = this.driveFailure(userId, got.status, got.json);
    if (denied) return denied;
    if (got.bytes.byteLength > DRIVE_READ_MAX_BYTES) return { ok: false, code: "too-large", message: TOO_LARGE, name: meta.name, mimeType: meta.mimeType };
    const text = new TextDecoder("utf-8", { fatal: false }).decode(got.bytes).replace(/^\uFEFF/, "");
    return this.textResult(meta, text, maxChars, "keep");
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
    } catch (err) {
      this.noteOAuthError(err);
      throw err;
    } finally {
      loop.close();
    }
  }

  private noteOAuthError(err: unknown): void {
    if (!(err instanceof GoogleConnectError) || !this.deps.debugLog) return;
    try {
      this.deps.debugLog(err.oauthError);
    } catch {
      /* best effort */
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
    if (!got) throw new GoogleConnectError(TOKEN_FAILED, "network");
    if (got.status !== 200) throw new GoogleConnectError(oauthTokenFailureMessage(got.json), oauthErrorCode(got.json));
    const parsed = parseGoogleTokenResponse(got.json, this.now());
    if (!parsed) throw new GoogleConnectError(TOKEN_FAILED, "token_invalid");
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
      this.noteOAuthError(new GoogleConnectError(REVOKED, "invalid_grant"));
      this.deps.write(dropToken(this.deps.read(), userId, id));
      return { error: { ok: false, code: "revoked", message: REVOKED } };
    }
    if (got.status !== 200) {
      const message = oauthTokenFailureMessage(got.json);
      this.noteOAuthError(new GoogleConnectError(message, oauthErrorCode(got.json)));
      return { error: { ok: false, code: "token", message } };
    }
    const parsed = parseGoogleTokenResponse(got.json, this.now());
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

  private async readBody(url: string, token: string, accept: string): Promise<{ status: number; bytes: Uint8Array; json: unknown } | null> {
    try {
      const res = await this.deps.fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: accept },
      });
      if (typeof res.arrayBuffer === "function") {
        const bytes = new Uint8Array(await res.arrayBuffer());
        return { status: res.status, bytes, json: res.status === 200 ? null : parseJsonBytes(bytes) };
      }
      if (typeof res.text === "function") {
        const text = await res.text();
        let json: unknown = null;
        if (res.status !== 200) {
          try { json = JSON.parse(text) as unknown; } catch { json = null; }
        }
        return { status: res.status, bytes: new TextEncoder().encode(text), json };
      }
      const json = await res.json().catch(() => null);
      return { status: res.status, bytes: new Uint8Array(), json };
    } catch {
      return null;
    }
  }
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}
