import { normalizeAttach } from "./attach";
import type { AttachModel, NoticeStatus, RoomNotice } from "./types";

export const ROOM_NOTICE_METHOD = "PUT";
export const ROOM_NOTICE_REGISTER_TEXT = "공지로 등록";
export const ROOM_NOTICE_REGISTER_CONFIRM = "공지 등록시 이전 공지는 삭제됩니다. 공지를 등록하시겠습니까?";
export const ROOM_NOTICE_CLOSE_CONFIRM = "해당 공지를 다시 볼 수 없게 됩니다. 계속 진행하시겠습니까?";

function positive(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label}가 올바르지 않습니다`);
  return n;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

export function roomNoticePath(roomSeq: unknown, messageId: unknown, me: unknown): string {
  const room = positive(roomSeq, "대화방");
  const message = positive(messageId, "메시지");
  const uid = positive(me, "사용자");
  return `/api/chat/notice/${encodeURIComponent(String(room))}?messageId=${encodeURIComponent(String(message))}&userSeq=${encodeURIComponent(String(uid))}`;
}

export function parseNotice(raw: unknown): RoomNotice | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const wrapper = raw as Record<string, any>;
  const value = wrapper.noticeMessage && typeof wrapper.noticeMessage === "object" ? wrapper.noticeMessage : wrapper;
  if (!value || typeof value !== "object") return undefined;
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) if (value[key] != null) return value[key];
    for (const key of keys) if (wrapper[key] != null) return wrapper[key];
    return undefined;
  };
  const messageRaw = value.message != null
    ? value.message
    : wrapper.message != null
    ? wrapper.message
    : typeof wrapper.noticeMessage === "string"
    ? wrapper.noticeMessage
    : undefined;
  const message = str(messageRaw);
  const createdAtRaw = pick("createdAt");
  const createdAt = createdAtRaw ? str(createdAtRaw) : undefined;
  const attach: AttachModel | undefined = normalizeAttach(
    pick("chatMessageAttachFileModel", "attach") as Record<string, any> | undefined,
    message || undefined,
    createdAt
  );
  const messageIdRaw = pick("messageId", "noticeMessageId");
  const n = messageIdRaw == null || messageIdRaw === "" ? NaN : Number(messageIdRaw);
  const messageId = Number.isFinite(n) && n > 0 ? n : undefined;
  const from = (pick("from") && typeof pick("from") === "object" ? pick("from") : {}) as Record<string, any>;
  const sendUserName = str(pick("sendUserName", "userName") ?? from.userName);
  const userImage = str(pick("userImage", "userImg") ?? from.userImg);
  if (messageId == null && !message && !attach) return undefined;
  const companyIdRaw = pick("companyId");
  return {
    messageId,
    message,
    sendUserName,
    userImage,
    companyId: companyIdRaw != null && Number.isFinite(Number(companyIdRaw)) ? Number(companyIdRaw) : undefined,
    createdAt,
    attach,
    deletedType: pick("deletedType") ? str(pick("deletedType")) : undefined,
    messageType: pick("messageType") ? str(pick("messageType")) : undefined,
  };
}

export function noticeStoreKey(messageId: unknown): string {
  const n = Number(messageId);
  return `notice_${Number.isFinite(n) && n > 0 ? n : String(messageId ?? "")}`;
}

export function normalizeNoticeStatus(raw: unknown): NoticeStatus {
  const value = typeof raw === "string" ? raw : raw && typeof raw === "object" ? (raw as any).status : "";
  const status = String(value || "").trim().toLowerCase();
  if (status === "summary" || status === "folded" || status === "closed") return status;
  return "normal";
}

export function isNoticeVisible(notice: RoomNotice | null | undefined, stored: unknown): boolean {
  if (!notice) return false;
  if (!notice.messageId && !notice.message && !notice.attach) return false;
  if (String(notice.deletedType || "").toUpperCase() === "DELETEDMESSAGE") return false;
  if (String(notice.messageType || "").toUpperCase() === "DELETEDFILE") return false;
  return normalizeNoticeStatus(stored) !== "closed";
}

export function noticeText(notice: RoomNotice): string {
  if (notice.attach?.name) return `📎 ${notice.attach.name}`;
  return notice.message;
}
