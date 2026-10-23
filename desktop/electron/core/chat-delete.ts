import type { ChatMessage } from "./types";

/**
 * Chat message deletion (v1.0.15).
 * PUT /api/chat/message/delete?userSeq=<me> with JSON {"ids":[...]}.
 * Deleting replaces the message with a server-side tombstone; the UI keeps the row but hides
 * text/attachments behind "삭제된 메시지입니다".
 */
export const CHAT_DELETE_PATH = "/api/chat/message/delete";
export const CHAT_DELETE_METHOD = "PUT";
export const CHAT_DELETE_CONFIRM = "해당 메세지의 내용이 삭제된 메세지로 표시됩니다. 정말 삭제하시겠습니까?";
export const CHAT_DELETED_PLACEHOLDER = "삭제된 메시지입니다";

const DELETED_STATUS = new Set(["DELETED", "DELETE", "D"]);
const DELETED_TYPE = new Set(["DELETED", "DELETEDMESSAGE"]);

/** Positive safe integers only, deduped. Throws when nothing valid remains. */
export function normalizeChatDeleteIds(ids: unknown): number[] {
  const raw = Array.isArray(ids) ? ids : [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of raw) {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  if (!out.length) throw new Error("삭제할 메시지를 선택하세요");
  return out;
}

/** Request body exactly as the API expects: {"ids":[messageId,...]}. */
export function chatDeleteBody(ids: unknown): { ids: number[] } {
  return { ids: normalizeChatDeleteIds(ids) };
}
export const buildChatDeleteBody = chatDeleteBody;

/** Mark matching rows as deleted without mutating the input (optimistic UI / rollback). */
export function applyChatDelete<T extends { messageId?: number }>(messages: T[], ids: unknown): Array<T & { deleted?: boolean }> {
  const del = new Set<number>();
  if (Array.isArray(ids)) {
    for (const v of ids) {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      if (Number.isSafeInteger(n) && n > 0) del.add(n);
    }
  }
  if (!del.size) return messages;
  return messages.map((m) => (m.messageId != null && del.has(m.messageId) ? { ...m, deleted: true } : m));
}

/** Tolerant check for server/realtime tombstones across known field spellings. */
export function isDeletedMessage(msg: any): boolean {
  if (!msg || typeof msg !== "object") return false;
  if (msg.deleted === true || msg.isDeleted === true) return true;
  const status = String(msg.status ?? msg.messageStatus ?? "").trim().toUpperCase();
  if (DELETED_STATUS.has(status)) return true;
  const type = String(msg.messageType ?? msg.type ?? "").trim().toUpperCase();
  return DELETED_TYPE.has(type);
}

/** Parse delete permission from /api/user/session data, including nested config objects. */
export function parseIsMessageDeletable(data: any): boolean | undefined {
  const read = (o: any): boolean | undefined => {
    if (!o || typeof o !== "object" || !("isMessageDeletable" in o)) return undefined;
    const v = o.isMessageDeletable;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (["true", "y", "yes", "1", "on"].includes(s)) return true;
      if (["false", "n", "no", "0", "off"].includes(s)) return false;
    }
    return undefined;
  };
  const seen = new Set<any>();
  const walk = (o: any, depth: number): boolean | undefined => {
    if (!o || typeof o !== "object" || depth > 4 || seen.has(o)) return undefined;
    seen.add(o);
    const direct = read(o);
    if (direct !== undefined) return direct;
    for (const k of ["config", "messengerConfig", "messenger", "chatConfig", "messageConfig", "settings", "data"]) {
      const found = walk(o[k], depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(data, 0);
}

/** UI permission helper: undefined means allowed (older servers / missing flag). */
export function canDeleteMessage(m: Pick<ChatMessage, "messageId" | "sendUserSeq" | "pending" | "failed"> & Record<string, any>, meId: number): boolean {
  if (m.messageId == null || m.sendUserSeq !== meId || m.pending || m.failed) return false;
  return !isDeletedMessage(m);
}
