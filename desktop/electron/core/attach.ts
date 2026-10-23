import type { AttachModel } from "./types";
import { tk } from "../../src/lib/i18n-core";

/**
 * DaouOffice chat attachment helpers (shared by main + renderer).
 * Server model: `chatMessageAttachFileModel` (REST) / `chatMessageAttachFileModel|attach` (XMPP JSON).
 * Known fields: cryptId, name, extention (sic), size, imageFile, thumbSmall/Mid/Large/Original.
 * Expiry / video fields are not documented in PROTOCOL.md, so several spellings are accepted.
 */
const EXPIRY_KEYS = ["expiredAt", "expireAt", "expireDate", "expiredDate", "expiryDate", "expirationDate", "validDate", "validUntil", "endDate", "deleteDate", "fileExpireDate"];
const VIDEO_THUMB_KEYS = ["videoThumb", "videoThumbnail", "thumbVideo", "posterUrl", "thumbnail"];
/**
 * Live (2026-10-23): the server model has NO expiry field (keys: cryptId,name,path,extention,size,preview,mobilePreview,
 * download,imageFile,thumb*). The official client shows "유효기간 : ~ upload+1y" (sent 2026.10.23 → 2027.10.23), so the
 * label is derived from createdAt + this retention unless the server ever sends an explicit date. `download:false` or
 * messageType DELETEDFILE = no longer downloadable.
 */
export const CHAT_FILE_RETENTION_DAYS = 365;
const DURATION_KEYS = ["duration", "playTime", "runningTime", "videoDuration"];

export const IMAGE_EXT = /^(png|jpe?g|gif|webp|bmp|heic|heif|svg)$/i;
export const VIDEO_EXT = /^(mp4|m4v|mov|webm|avi|mkv|wmv|3gp)$/i;

function str(v: unknown): string | undefined {
  return v == null || v === "" ? undefined : String(v);
}

export function extOf(name?: string, ext?: string): string {
  if (ext) return String(ext).replace(/^\./, "").toLowerCase();
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

/** Parse ms-epoch numbers, "yyyyMMdd", "yyyy-MM-dd[ HH:mm[:ss]]", ISO strings. */
export function parseExpiry(v: unknown): string | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number" || /^\d{10,13}$/.test(String(v))) {
    let n = Number(v);
    if (n < 1e12) n *= 1000;
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const s = String(v).trim();
  const ymd = /^(\d{4})[.\-/]?(\d{2})[.\-/]?(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (ymd) {
    const [, y, mo, d, h, mi, se] = ymd;
    // date-only expiry = valid through end of that day (KST)
    const t = h ? `${h}:${mi}:${se || "00"}` : "23:59:59";
    return new Date(`${y}-${mo}-${d}T${t}+09:00`).toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function normalizeAttach(a: Record<string, any> | null | undefined, fallbackName?: string, createdAt?: string): AttachModel | undefined {
  if (!a || typeof a !== "object") return undefined;
  const cryptId = str(a.cryptId ?? a.cryptAttachText ?? a.fileId ?? a.attachId);
  if (!cryptId) return undefined;
  const name = String(a.name || a.fileName || a.originalName || fallbackName || "file");
  const extention = str(a.extention ?? a.extension) ?? (extOf(name) || undefined);
  let expiresAt: string | undefined;
  for (const k of EXPIRY_KEYS) if (a[k] != null && (expiresAt = parseExpiry(a[k]))) break;
  if (!expiresAt && createdAt) {
    const t = Date.parse(createdAt);
    if (Number.isFinite(t)) expiresAt = parseExpiry(new Date(t + CHAT_FILE_RETENTION_DAYS * 86400_000 + 9 * 3600_000).toISOString().slice(0, 10));
  }
  let duration: number | undefined;
  for (const k of DURATION_KEYS) if (a[k] != null && Number.isFinite(Number(a[k]))) { duration = Number(a[k]); break; }
  let videoThumb: string | undefined;
  for (const k of VIDEO_THUMB_KEYS) if ((videoThumb = str(a[k]))) break;
  const expiredFlag = a.expired === true || a.isExpired === true || a.expire === true || a.status === "EXPIRED" || a.download === false || a.download === "false";
  return {
    cryptId,
    name,
    extention,
    size: a.size != null && Number.isFinite(Number(a.size)) ? Number(a.size) : undefined,
    imageFile: !!a.imageFile,
    videoFile: !!(a.videoFile || a.movieFile) || undefined,
    thumbSmall: str(a.thumbSmall),
    thumbMid: str(a.thumbMid),
    thumbLarge: str(a.thumbLarge),
    thumbOriginal: str(a.thumbOriginal),
    videoThumb,
    duration,
    width: a.width != null ? Number(a.width) || undefined : undefined,
    height: a.height != null ? Number(a.height) || undefined : undefined,
    expiresAt,
    expired: expiredFlag || undefined,
  };
}

export type AttachKind = "image" | "video" | "file";
export function attachKind(a: AttachModel): AttachKind {
  const e = extOf(a.name, a.extention);
  if (a.videoFile || VIDEO_EXT.test(e)) return "video";
  if (a.imageFile || IMAGE_EXT.test(e)) return "image";
  return "file";
}

export function isExpired(a: AttachModel, now = Date.now()): boolean {
  if (a.expired) return true;
  if (!a.expiresAt) return false;
  const t = Date.parse(a.expiresAt);
  return Number.isFinite(t) && t < now;
}

/** "유효기간 : ~ 2027.10.23" (KST). */
export function expiryLabel(a: AttachModel): string {
  if (!a.expiresAt) return a.expired ? tk("유효기간 만료") : "";
  const d = new Date(Date.parse(a.expiresAt) + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `유효기간 : ~ ${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}`;
}

/** DaouOffice-style size: "80MB", "1.7MB", "512KB", "900B". */
export function sizeLabel(n?: number): string {
  if (n == null || !Number.isFinite(n)) return "";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  if (n < 1024 ** 3) { const mb = n / 1024 / 1024; return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1).replace(/\.0$/, "")}MB`; }
  return `${(n / 1024 ** 3).toFixed(1).replace(/\.0$/, "")}GB`;
}

export function durationLabel(sec?: number): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return "";
  if (sec > 36000) sec = sec / 1000; // ms → s
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
}

export type FileIcon = { label: string; color: string };
/** Extension → short badge + color, used for the generic file card icon. */
export function fileIcon(name?: string, ext?: string): FileIcon {
  const e = extOf(name, ext);
  if (/^(pdf)$/.test(e)) return { label: "PDF", color: "#e5484d" };
  if (/^(xlsx?|csv|cell)$/.test(e)) return { label: "XLS", color: "#1f9d55" };
  if (/^(docx?|rtf|odt)$/.test(e)) return { label: "DOC", color: "#2f6fdb" };
  if (/^(pptx?|show|key)$/.test(e)) return { label: "PPT", color: "#e8710a" };
  if (/^(hwpx?)$/.test(e)) return { label: "HWP", color: "#1aa3c8" };
  if (/^(zip|7z|rar|tar|gz|alz|egg)$/.test(e)) return { label: "ZIP", color: "#8e6c3a" };
  if (IMAGE_EXT.test(e)) return { label: "IMG", color: "#7c5cff" };
  if (VIDEO_EXT.test(e)) return { label: "VID", color: "#d6336c" };
  if (/^(mp3|wav|m4a|aac|flac|ogg)$/.test(e)) return { label: "AUD", color: "#c2255c" };
  if (/^(txt|log|md|json|xml)$/.test(e)) return { label: "TXT", color: "#6b7280" };
  if (/^(exe|msi|dmg|pkg|apk)$/.test(e)) return { label: "APP", color: "#495057" };
  return { label: (e || "FILE").slice(0, 4).toUpperCase(), color: "#6b7280" };
}
