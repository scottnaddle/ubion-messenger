/**
 * Google OAuth for 내 봇 (desktop public client).
 * PKCE + loopback. No client secret in this module. Tokens are not logged.
 */
import http from "node:http";
import fs from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** File content and metadata. Not the full `drive` scope and not `drive.file`. */
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
/** 1.1.5 grant. Lists names but cannot download bytes. No longer requested. */
export const GOOGLE_DRIVE_METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const DRIVE_READ_DEFAULT_CHARS = 12_000;
export const DRIVE_READ_MAX_CHARS = 20_000;
export const DRIVE_READ_MAX_BYTES = 20 * 1024 * 1024;
export const DRIVE_SCAN_NOTE = "텍스트를 추출하지 못했습니다(스캔본일 수 있음).";
export const DRIVE_EMPTY_NOTE = "텍스트를 추출하지 못했습니다.";
export const DRIVE_RECONNECT_MESSAGE = "Drive 파일 내용을 읽으려면 권한을 다시 받아야 합니다. Google Drive 행에서 연결을 다시 눌러 주세요.";
export const DRIVE_NAME_ONLY_NOTE = "파일 이름만 검색했습니다. 본문 검색과 읽기는 Google Drive 행에서 연결을 다시 눌러 주세요.";
export const DRIVE_MIME_ERROR = "지원하지 않는 형식 필터입니다. pdf, document, spreadsheet, presentation, docx, xlsx, pptx, text, csv, html 중 하나를 쓰세요.";

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

export function clipReadChars(value: unknown, fallback = DRIVE_READ_DEFAULT_CHARS, max = DRIVE_READ_MAX_CHARS): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

const DRIVE_FILE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

export function cleanDriveFileId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return DRIVE_FILE_ID_RE.test(id) ? id : null;
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Up to five tokens from a name or keyword search. */
export function driveKeywords(query: string): string[] {
  const raw = query.trim().slice(0, 100);
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/\s+/)) {
    const kw = part.trim();
    if (!kw) continue;
    out.push(kw.slice(0, 40));
    if (out.length >= 5) break;
  }
  return out;
}

const DRIVE_MIME_ALIASES: Record<string, string> = {
  pdf: "application/pdf",
  document: "application/vnd.google-apps.document",
  doc: "application/vnd.google-apps.document",
  gdoc: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  sheet: "application/vnd.google-apps.spreadsheet",
  sheets: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
  slide: "application/vnd.google-apps.presentation",
  slides: "application/vnd.google-apps.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  word: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  excel: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  powerpoint: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  text: "text/plain",
  markdown: "text/markdown",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
};

/** A Drive `q` mime clause, or invalid when the filter is not a known alias or mime type. */
export function driveMimeClause(mime: string | undefined): { ok: true; clause?: string } | { ok: false } {
  if (typeof mime !== "string" || !mime.trim()) return { ok: true };
  const raw = mime.trim().toLowerCase();
  const alias = DRIVE_MIME_ALIASES[raw];
  if (alias) return { ok: true, clause: `mimeType = '${alias}'` };
  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(raw) && raw.length <= 140) return { ok: true, clause: `mimeType = '${raw}'` };
  return { ok: false };
}

export type DriveListOptions = {
  mime?: string;
  folderId?: string;
  /** When false, search file names only (metadata-only tokens). Default true. */
  contentSearch?: boolean;
};

export function driveSearchQuery(query: string, options: DriveListOptions = {}): string {
  const parts = ["trashed = false"];
  const folder = cleanDriveFileId(options.folderId);
  if (folder) parts.push(`'${folder}' in parents`);
  const mime = driveMimeClause(options.mime);
  if (mime.ok && mime.clause) parts.push(mime.clause);
  const content = options.contentSearch !== false;
  for (const kw of driveKeywords(query)) {
    const escaped = escapeDriveQuery(kw);
    parts.push(content
      ? `(name contains '${escaped}' or fullText contains '${escaped}')`
      : `name contains '${escaped}'`);
  }
  return parts.join(" and ");
}

export function driveListUrl(query: string, limit: number, options: DriveListOptions = {}): string {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("pageSize", String(limit));
  url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,parents)");
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  const q = driveSearchQuery(query, options);
  url.searchParams.set("q", q);
  if (!q.includes("fullText")) url.searchParams.set("orderBy", "modifiedTime desc");
  return url.toString();
}

export function driveParentsUrl(ids: readonly string[]): string {
  const unique = [...new Set(ids.map((id) => cleanDriveFileId(id)).filter((id): id is string => !!id))].slice(0, 10);
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("pageSize", String(Math.max(1, unique.length)));
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("q", unique.map((id) => `id = '${id}'`).join(" or ") || "trashed = false");
  return url.toString();
}

export function driveFileMetaUrl(fileId: string): string {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", "id,name,mimeType,size");
  url.searchParams.set("supportsAllDrives", "true");
  return url.toString();
}

export function driveExportUrl(fileId: string, exportMime: string): string {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export`);
  url.searchParams.set("mimeType", exportMime);
  url.searchParams.set("supportsAllDrives", "true");
  return url.toString();
}

export function driveMediaUrl(fileId: string): string {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  return url.toString();
}

export type DriveFileItem = { id: string; name: string; mimeType: string; modifiedTime?: string; folder?: string };

export type ParsedDriveFile = { id: string; name: string; mimeType: string; modifiedTime?: string; parentId?: string };

export function parseDriveFiles(payload: unknown, limit: number): ParsedDriveFile[] {
  const files = payload && typeof payload === "object" ? (payload as { files?: unknown }).files : null;
  if (!Array.isArray(files)) return [];
  const out: ParsedDriveFile[] = [];
  for (const item of files) {
    if (!item || typeof item !== "object") continue;
    const row = item as { id?: unknown; name?: unknown; mimeType?: unknown; modifiedTime?: unknown; parents?: unknown };
    if (typeof row.id !== "string" || typeof row.name !== "string") continue;
    const parent = Array.isArray(row.parents) ? row.parents.find((id) => cleanDriveFileId(id)) : undefined;
    out.push({
      id: row.id.slice(0, 200),
      name: row.name.slice(0, 180),
      mimeType: typeof row.mimeType === "string" ? row.mimeType.slice(0, 160) : "",
      ...(typeof row.modifiedTime === "string" ? { modifiedTime: row.modifiedTime.slice(0, 40) } : {}),
      ...(typeof parent === "string" ? { parentId: parent.slice(0, 200) } : {}),
    });
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => (b.modifiedTime || "").localeCompare(a.modifiedTime || ""));
}

export function parseDriveNames(payload: unknown): Record<string, string> {
  const files = payload && typeof payload === "object" ? (payload as { files?: unknown }).files : null;
  const out: Record<string, string> = {};
  if (!Array.isArray(files)) return out;
  for (const item of files) {
    if (!item || typeof item !== "object") continue;
    const row = item as { id?: unknown; name?: unknown };
    if (typeof row.id !== "string" || typeof row.name !== "string" || !row.name.trim()) continue;
    out[row.id.slice(0, 200)] = row.name.slice(0, 180);
  }
  return out;
}

export type DriveFileMeta = { id: string; name: string; mimeType: string; size?: number };

export function parseDriveFileMeta(payload: unknown): DriveFileMeta | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as { id?: unknown; name?: unknown; mimeType?: unknown; size?: unknown };
  const id = typeof row.id === "string" ? row.id.slice(0, 200) : "";
  const mimeType = typeof row.mimeType === "string" ? row.mimeType.slice(0, 160) : "";
  if (!id || !mimeType) return null;
  let size: number | undefined;
  if (typeof row.size === "string" && /^\d{1,16}$/.test(row.size)) {
    const n = Number(row.size);
    if (Number.isSafeInteger(n)) size = n;
  } else if (typeof row.size === "number" && Number.isSafeInteger(row.size) && row.size >= 0) {
    size = row.size;
  }
  const name = typeof row.name === "string" && row.name.trim() ? row.name.slice(0, 180) : "(이름 없음)";
  return { id, name, mimeType, ...(size !== undefined ? { size } : {}) };
}

const FULL_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

/** Empty scope means "unknown" — try the API. Metadata-only grants cannot download bytes. */
export function driveScopeAllowsContent(scope: string | undefined): boolean {
  if (typeof scope !== "string" || !scope.trim()) return true;
  const parts = scope.split(/\s+/).filter(Boolean);
  return parts.includes(GOOGLE_DRIVE_SCOPE) || parts.includes(FULL_DRIVE_SCOPE);
}

function collectField(value: unknown, key: string, depth = 0, out: string[] = []): string[] {
  if (!value || depth > 8) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectField(item, key, depth + 1, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [k, child] of Object.entries(value as Record<string, unknown>)) {
      if (k === key && typeof child === "string") out.push(child);
      else collectField(child, key, depth + 1, out);
    }
  }
  return out;
}

/**
 * True only for a token that lacks the Drive content scope.
 * `insufficientFilePermissions` is a single-file ACL miss and must not clear the token.
 */
export function isInsufficientDriveScope(status: number, payload: unknown): boolean {
  if (status !== 403) return false;
  const reasons = collectField(payload, "reason").map((reason) => reason.toLowerCase().replace(/[\s_-]+/g, ""));
  if (reasons.some((reason) => reason.includes("insufficientfilepermission"))) return false;
  if (reasons.some((reason) => reason === "insufficientpermissions" || reason === "accesstokenscopeinsufficient")) return true;
  return collectField(payload, "message").some((message) => /insufficient authentication scopes/i.test(message));
}

export function truncateDriveText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const normalized = text.replace(/\u0000/g, "").replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  const cap = clipReadChars(maxChars);
  if (normalized.length <= cap) return { text: normalized, truncated: false };
  return { text: normalized.slice(0, cap), truncated: true };
}

export type DriveReadRoute =
  | { kind: "export"; exportMime: "text/plain" | "text/csv" }
  | { kind: "pdf" }
  | { kind: "text"; html: boolean }
  | { kind: "docx" | "xlsx" | "pptx" }
  | { kind: "unsupported"; message: string };

const DOCX_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "application/vnd.ms-word.document.macroenabled.12",
]);
const XLSX_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  "application/vnd.ms-excel.sheet.macroenabled.12",
]);
const PPTX_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.template",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12",
]);

function normalizeMime(mimeType: string): string {
  return mimeType.toLowerCase().split(";")[0]?.trim() || "";
}

function unsupportedDriveMessage(mime: string): string {
  if (mime === "application/vnd.google-apps.folder") return "폴더 전체는 읽지 않습니다. 파일을 찾은 뒤 하나씩 읽으며, 만들거나 수정·삭제·이동하지 않습니다.";
  if (mime === "application/vnd.google-apps.shortcut") return "바로가기는 읽지 않습니다. 대상 파일을 찾으세요.";
  if (mime.startsWith("image/")) return "이미지 파일은 텍스트로 읽지 않습니다. 수정·삭제하지 않습니다.";
  if (mime.startsWith("video/") || mime.startsWith("audio/")) return "동영상·음성 파일은 텍스트로 읽지 않습니다. 수정·삭제하지 않습니다.";
  if (mime === "application/zip" || mime === "application/x-zip-compressed" || mime === "application/gzip" || mime === "application/x-tar" || mime === "application/vnd.rar" || mime === "application/x-7z-compressed") {
    return "압축 파일은 열지 않습니다. 수정·삭제하지 않습니다.";
  }
  if (mime === "application/msword" || mime === "application/vnd.ms-excel" || mime === "application/vnd.ms-powerpoint") {
    return "예전 Office 파일(.doc, .xls, .ppt)은 텍스트로 읽지 않습니다. docx, xlsx 또는 Google 문서를 사용하세요.";
  }
  return "이 형식의 파일 내용은 읽지 않습니다. 수정·삭제하지 않습니다.";
}

export function routeDriveMime(mimeType: string): DriveReadRoute {
  const mime = normalizeMime(mimeType);
  if (mime === "application/vnd.google-apps.document" || mime === "application/vnd.google-apps.presentation") {
    return { kind: "export", exportMime: "text/plain" };
  }
  if (mime === "application/vnd.google-apps.spreadsheet") return { kind: "export", exportMime: "text/csv" };
  if (mime === "application/pdf") return { kind: "pdf" };
  if (DOCX_MIMES.has(mime)) return { kind: "docx" };
  if (XLSX_MIMES.has(mime)) return { kind: "xlsx" };
  if (PPTX_MIMES.has(mime)) return { kind: "pptx" };
  if (mime === "text/html" || mime === "application/xhtml+xml") return { kind: "text", html: true };
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || mime === "application/csv") {
    return { kind: "text", html: false };
  }
  return { kind: "unsupported", message: unsupportedDriveMessage(mime) };
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

const OAUTH_ERROR_CODE_RE = /^[a-z0-9_]{1,64}$/;
/**
 * Google authorization codes include a slash (docs example: `4/P7q7...`).
 * An allowlist without `/` rejects the callback after the user has already consented.
 */
const AUTH_CODE_RE = /^[A-Za-z0-9._~+/=-]{8,512}$/;

export function sanitizeOAuthErrorCode(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const code = value.trim().toLowerCase();
  return OAUTH_ERROR_CODE_RE.test(code) ? code : "unknown";
}

/** Short, single-line detail safe to show in a toast. Drops tokens, codes, and secrets. */
export function sanitizeOAuthDetail(value: unknown, max = 160): string {
  if (typeof value !== "string") return "";
  const secretish = /(?:ya29\.[A-Za-z0-9._-]+|1\/\/\S+|GOCSPX-[A-Za-z0-9_-]+|4\/[A-Za-z0-9._~+/=-]{8,}|(?:access_token|refresh_token|id_token|client_secret|code_verifier|client_id|code)=[^\s&]+|[A-Za-z0-9._~+/=-]{40,})/gi;
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(secretish, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function isGoogleAuthCode(code: string): boolean {
  return AUTH_CODE_RE.test(code);
}

function mentionsTestingOrVerification(description: string): boolean {
  return /testing|verification|verified|unverified|\btested\b|test user|테스트|검증/i.test(description);
}

function withOAuthDetail(message: string, code: string, description: string): string {
  const suffix = description ? ` (${code}: ${description})` : ` (${code})`;
  return `${message}${suffix}`;
}

/** Korean toast for a loopback `error` / `error_description`. */
export function oauthCallbackMessage(errorCode: string, description: unknown): string {
  const code = sanitizeOAuthErrorCode(errorCode);
  const detail = sanitizeOAuthDetail(description);
  if (code === "access_denied") {
    const base = mentionsTestingOrVerification(detail)
      ? "Google 연결이 취소되었습니다. GCP 테스트 사용자(cwdaddy@gmail.com 또는 edtechnewsroom@gmail.com)로 로그인해 주세요."
      : "Google 연결이 취소되었습니다.";
    return withOAuthDetail(base, code, detail);
  }
  if (code === "redirect_uri_mismatch") {
    return withOAuthDetail("Google 리다이렉트 주소가 일치하지 않습니다. Desktop 클라이언트인지 확인해 주세요.", code, detail);
  }
  if (code === "invalid_client") {
    return withOAuthDetail("Google 클라이언트 ID 또는 비밀번호가 올바르지 않습니다. google-oauth.json을 확인해 주세요.", code, detail);
  }
  return withOAuthDetail("Google 연결을 확인하지 못했습니다.", code, detail);
}

function readGoogleOAuthError(payload: unknown): { code: string; description: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "string" || !error.trim()) return null;
  return {
    code: sanitizeOAuthErrorCode(error),
    description: sanitizeOAuthDetail((payload as { error_description?: unknown }).error_description),
  };
}

/** Korean toast when the token endpoint is not HTTP 200. */
export function oauthTokenFailureMessage(payload: unknown): string {
  const base = "Google 토큰을 받지 못했습니다.";
  const parsed = readGoogleOAuthError(payload);
  if (!parsed) return base;
  if (parsed.code === "invalid_client") {
    return withOAuthDetail(`${base} 클라이언트 ID 또는 비밀번호를 확인해 주세요.`, parsed.code, parsed.description);
  }
  if (parsed.code === "redirect_uri_mismatch") {
    return withOAuthDetail(`${base} 리다이렉트 주소가 일치하지 않습니다.`, parsed.code, parsed.description);
  }
  return withOAuthDetail(base, parsed.code, parsed.description);
}

/** Log token only. Never the description, auth code, or secret. */
export function oauthErrorCode(payload: unknown): string {
  return readGoogleOAuthError(payload)?.code ?? "token_failed";
}

export class GoogleConnectError extends Error {
  readonly oauthError: string;
  constructor(message: string, oauthError: string) {
    super(message);
    this.name = "GoogleConnectError";
    this.oauthError = sanitizeOAuthErrorCode(oauthError);
  }
}

/** One line in userData/google-oauth-debug.log: ISO time and a sanitized error code. Mode 0600. */
export function appendGoogleOAuthDebugLog(
  filePath: string,
  code: string,
  io: Pick<typeof fs, "appendFileSync" | "chmodSync" | "statSync" | "renameSync"> = fs,
): void {
  const line = `${new Date().toISOString()} ${sanitizeOAuthErrorCode(code)}\n`;
  try {
    try {
      if (io.statSync(filePath).size > 64 * 1024) io.renameSync(filePath, `${filePath}.1`);
    } catch {
      /* new file */
    }
    io.appendFileSync(filePath, line, { mode: 0o600 });
    io.chmodSync(filePath, 0o600);
  } catch {
    /* best effort */
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function failPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>UBION</title><p>${escapeHtml(message)}</p>`;
}

/** Read `code` without turning a literal `+` into a space. */
function readAuthCode(search: string): string {
  const q = search.startsWith("?") ? search.slice(1) : search;
  for (const part of q.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    let key = "";
    try {
      key = decodeURIComponent(part.slice(0, eq).replace(/\+/g, "%2B"));
    } catch {
      continue;
    }
    if (key !== "code") continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).replace(/\+/g, "%2B"));
    } catch {
      return "";
    }
  }
  return "";
}

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
      const description = url.searchParams.get("error_description");
      const code = readAuthCode(url.search);
      const state = url.searchParams.get("state") || "";
      settled = true;
      clearTimeout(timer);
      if (error) {
        const safeCode = sanitizeOAuthErrorCode(error);
        const message = oauthCallbackMessage(safeCode, description);
        write(400, failPage(message));
        fail(new GoogleConnectError(message, safeCode));
        return;
      }
      if (!sameState(state, expectedState)) {
        const message = "Google 연결을 확인하지 못했습니다. 응답 state가 일치하지 않습니다.";
        write(400, failPage(message));
        fail(new GoogleConnectError(message, "invalid_state"));
        return;
      }
      if (!isGoogleAuthCode(code)) {
        const message = "Google 연결을 확인하지 못했습니다. 인증 코드가 올바르지 않습니다.";
        write(400, failPage(message));
        fail(new GoogleConnectError(message, "invalid_code"));
        return;
      }
      write(200, SUCCESS_HTML);
      finish(code);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      fail(new GoogleConnectError("Google 연결 시간이 초과되었습니다.", "timeout"));
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
