/**
 * 대화 백업 · 대화 기록 삭제 — pure path/parse helpers (no Electron, safe to import from the renderer).
 *
 * Original 3.5.42 renderer:
 *   request  POST   /api/chat/{roomSeq}/backup?userSeq=   JSON {fromDate,toDate,fileType:"TXT"|"HTML"}
 *            dates = moment(startOf/endOf day).format("YYYY-MM-DDTHH:mm:ss.SSSZ")
 *   poll     GET    /api/chat/backup/list?userSeq=        → {data:[{id,roomSeq,status,file:{name}}]}, every 1s while any status != "DONE"
 *   download GET    /api/chat/{roomSeq}/backup/{backupId}/download?userSeq=
 *   delete   DELETE /api/chat/{roomSeq}/backup/{backupId}?userSeq=   (also used as "cancel" while PROGRESS)
 */

import { tk } from "../../src/lib/i18n-core";

export const BACKUP_FILE_TYPES = ["TXT", "HTML"] as const;
export type BackupFileType = (typeof BACKUP_FILE_TYPES)[number];
export const BACKUP_DEFAULT_FILE_TYPE: BackupFileType = "TXT";
export const BACKUP_STATUS_DONE = "DONE";
export const BACKUP_STATUS_PROGRESS = "PROGRESS";
export const BACKUP_STATUS_FAIL = "FAIL";
export const BACKUP_POLL_MS = 1000;
/** Stop polling after this many rounds even if the server never reports DONE. */
export const BACKUP_POLL_MAX = 120;
export const BACKUP_MAX_RANGE_DAYS = 366;
export const BACKUP_DELETE_CONFIRM = "백업 파일을 삭제하시겠습니까?";

/**
 * ⚠ UNVERIFIED. The plan maps "대화 기록 삭제" to PUT …/{messageId}/before, but in the original bundle that PUT
 * is the mark-read action (iu → /api/{chat/buddies|chat/rooms|chat/pubsubs}/{room}/{msg}/before) and
 * "대화 기록 삭제하기" is only a checkbox on the leave-room dialog. Keep it off unless UBM_HISTORY_CLEAR=1.
 */
export const HISTORY_CLEAR_ENV = "UBM_HISTORY_CLEAR";
export const HISTORY_CLEAR_METHOD = "PUT";
export const HISTORY_CLEAR_CONFIRM =
  "이 대화방의 대화 기록을 삭제하시겠습니까? 삭제한 기록은 되돌릴 수 없습니다. (내 화면에서만 삭제)";

export function historyClearEnabled(env: Record<string, string | undefined> | undefined): boolean {
  return env?.[HISTORY_CLEAR_ENV] === "1";
}

export type BackupStatus = "DONE" | "PROGRESS" | "FAIL" | string;
export type BackupItem = {
  id: number;
  roomSeq: number;
  status: BackupStatus;
  fileName: string;
  fileType?: BackupFileType;
  fromDate?: string;
  toDate?: string;
  createdAt?: string;
  size?: number;
};
export type BackupRequest = { fromDate: string; toDate: string; fileType: BackupFileType };

function positive(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label}가 올바르지 않습니다`);
  return n;
}

const enc = (n: number) => encodeURIComponent(String(n));

export function backupRequestPath(roomSeq: unknown, me: unknown): string {
  return `/api/chat/${enc(positive(roomSeq, "대화방"))}/backup?userSeq=${enc(positive(me, "사용자"))}`;
}

export function backupListPath(me: unknown): string {
  return `/api/chat/backup/list?userSeq=${enc(positive(me, "사용자"))}`;
}

export function backupDownloadPath(roomSeq: unknown, backupId: unknown, me: unknown): string {
  const room = positive(roomSeq, "대화방");
  const id = positive(backupId, "백업");
  return `/api/chat/${enc(room)}/backup/${enc(id)}/download?userSeq=${enc(positive(me, "사용자"))}`;
}

export function backupDeletePath(roomSeq: unknown, backupId: unknown, me: unknown): string {
  const room = positive(roomSeq, "대화방");
  const id = positive(backupId, "백업");
  return `/api/chat/${enc(room)}/backup/${enc(id)}?userSeq=${enc(positive(me, "사용자"))}`;
}

/** ⚠ Unverified semantics — see HISTORY_CLEAR_ENV. Distinct from markRead's /api/chat/rooms|buddies/… path. */
export function historyClearPath(roomSeq: unknown, messageId: unknown, me: unknown): string {
  const room = positive(roomSeq, "대화방");
  const message = positive(messageId, "메시지");
  return `/api/chat/${enc(room)}/${enc(message)}/before?userSeq=${enc(positive(me, "사용자"))}`;
}

export function normalizeBackupFileType(value: unknown): BackupFileType {
  const t = String(value ?? "").trim().toUpperCase();
  if (t === "") return BACKUP_DEFAULT_FILE_TYPE;
  if (t === "TXT" || t === "HTML") return t;
  throw new Error("백업 파일 형식이 올바르지 않습니다");
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");

function parseDay(value: unknown, label: string): { y: number; m: number; d: number } {
  const s = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) throw new Error(`${label}을 선택하세요`);
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d)
    throw new Error(`${label}이 올바르지 않습니다`);
  return { y, m, d };
}

/** moment's "Z" token: minutes east of UTC → "+09:00". (Date#getTimezoneOffset is west-positive; negate it.) */
export function formatOffset(minutesEast: number): string {
  const sign = minutesEast < 0 ? "-" : "+";
  return `${sign}${pad(Math.trunc(minutesEast / 60))}:${pad(minutesEast % 60)}`;
}

function localOffsetEast(y: number, m: number, d: number): number {
  return -new Date(y, m - 1, d).getTimezoneOffset();
}

/**
 * "YYYY-MM-DD" pair → the original's {fromDate,toDate}: start of the first day / end of the last day,
 * formatted "YYYY-MM-DDTHH:mm:ss.SSSZ". `offsetEast` (minutes) is injectable for tests; default = local zone.
 */
export function buildBackupRequest(
  from: unknown,
  to: unknown,
  fileType: unknown = BACKUP_DEFAULT_FILE_TYPE,
  offsetEast?: number,
): BackupRequest {
  const a = parseDay(from, "시작일");
  const b = parseDay(to, "종료일");
  const ta = Date.UTC(a.y, a.m - 1, a.d);
  const tb = Date.UTC(b.y, b.m - 1, b.d);
  if (ta > tb) throw new Error("시작일이 종료일보다 늦습니다");
  if ((tb - ta) / 86_400_000 + 1 > BACKUP_MAX_RANGE_DAYS) throw new Error(`백업 기간은 최대 ${BACKUP_MAX_RANGE_DAYS}일입니다`);
  const day = (p: { y: number; m: number; d: number }) => `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
  const offA = formatOffset(offsetEast ?? localOffsetEast(a.y, a.m, a.d));
  const offB = formatOffset(offsetEast ?? localOffsetEast(b.y, b.m, b.d));
  return {
    fromDate: `${day(a)}T00:00:00.000${offA}`,
    toDate: `${day(b)}T23:59:59.999${offB}`,
    fileType: normalizeBackupFileType(fileType),
  };
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function optNum(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function posInt(value: unknown): number | undefined {
  const n = optNum(value);
  return n != null && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export function parseBackupItem(raw: unknown): BackupItem | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, any>;
  const id = posInt(v.id ?? v.backupId ?? v.seq);
  const roomSeq = posInt(v.roomSeq ?? v.buddyRoomSeq ?? v.room?.roomSeq);
  if (id == null || roomSeq == null) return undefined;
  const file = v.file && typeof v.file === "object" ? (v.file as Record<string, any>) : {};
  const fileTypeRaw = str(v.fileType ?? file.fileType).toUpperCase();
  const fileType = fileTypeRaw === "TXT" || fileTypeRaw === "HTML" ? fileTypeRaw : undefined;
  const fileName = str(file.name ?? v.fileName ?? v.backupFileName).trim();
  return {
    id,
    roomSeq,
    status: str(v.status).trim().toUpperCase() || BACKUP_STATUS_PROGRESS,
    fileName,
    fileType,
    fromDate: v.fromDate != null ? str(v.fromDate) : undefined,
    toDate: v.toDate != null ? str(v.toDate) : undefined,
    createdAt: v.createdAt != null ? str(v.createdAt) : undefined,
    size: optNum(file.size ?? v.size),
  };
}

/** Accepts {data:[…]}, {data:{list|content:[…]}}, {list:[…]}, a bare array, or junk (→ []). */
export function parseBackupList(raw: unknown): BackupItem[] {
  let list: unknown = raw;
  if (list && typeof list === "object" && !Array.isArray(list)) {
    const o = list as Record<string, any>;
    list = o.data ?? o.list ?? o.content ?? o.backupList;
    if (list && typeof list === "object" && !Array.isArray(list)) {
      const d = list as Record<string, any>;
      list = d.list ?? d.content ?? d.data ?? d.backupList;
    }
  }
  if (!Array.isArray(list)) return [];
  const out: BackupItem[] = [];
  const seen = new Set<number>();
  for (const item of list) {
    const b = parseBackupItem(item);
    if (!b || seen.has(b.id)) continue;
    seen.add(b.id);
    out.push(b);
  }
  return out;
}

export function backupsForRoom(list: BackupItem[], roomSeq: number): BackupItem[] {
  return list.filter((b) => b.roomSeq === roomSeq);
}

export function isBackupDone(b: Pick<BackupItem, "status">): boolean {
  return b.status === BACKUP_STATUS_DONE;
}

/** Keep polling while something is still being built (the original polled until all were DONE; we also stop on FAIL). */
export function shouldPollBackups(list: BackupItem[]): boolean {
  return list.some((b) => b.status !== BACKUP_STATUS_DONE && b.status !== BACKUP_STATUS_FAIL);
}

export function backupStatusLabel(status: BackupStatus): string {
  switch (status) {
    case BACKUP_STATUS_DONE: return tk("완료");
    case BACKUP_STATUS_FAIL: return tk("실패");
    case BACKUP_STATUS_PROGRESS:
    case "REQUEST": return tk("백업 중");
    default: return status || tk("백업 중");
  }
}

export function backupFileName(b: Pick<BackupItem, "id" | "roomSeq" | "fileName" | "fileType">): string {
  if (b.fileName) return b.fileName;
  const ext = b.fileType === "HTML" ? "html" : b.fileType === "TXT" ? "txt" : "zip";
  return `chat_backup_${b.roomSeq}_${b.id}.${ext}`;
}

/** Server code check shared by the backup mutations (2xx with a {code:"500"} body is still a failure). */
export function backupBodyError(text: string): { status: number; message?: string } | null {
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (body?.code == null || String(body.code) === "200") return null;
  const n = Number(body.code);
  return {
    status: Number.isInteger(n) && n >= 100 && n <= 599 ? n : 500,
    message: body.message ?? body.msg ?? body.data?.message,
  };
}
