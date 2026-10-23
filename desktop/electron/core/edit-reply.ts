/**
 * 메시지 수정 / 답장(인용). DaouOffice has no native edit/thread API (findings 6b/6c), so both are
 * implemented with the M pattern (special-format message):
 *
 *   edit:  delete the original (existing PUT /api/chat/message/delete) then resend
 *          "<newText>\n(수정됨)[[ubm:edit:<origId>]]". UBION collapses this into a "(수정됨)" tag.
 *   reply: one message "> 이름: 원문…\n<reply>[[re:<msgId>]]" → UBION renders a quote block.
 *
 * Both the edit resend and the quote reply are NEW message-sending paths, so they must pass the
 * shared self-only guard (checkForwardTarget) before sending — reuse `guardEditReplyTarget`.
 *
 * ⚠ Delete time/permission limits are UNVERIFIED. Edit is behind UBM_EDIT (default ON; only the
 *   self-only guard can still block a resend).
 */
import { apiRoomSeq, checkForwardTarget } from "./forward";
import type { Room } from "./types";
import { composeEditText, composeQuoteText } from "../../src/lib/markers";

export const EDIT_ENV = "UBM_EDIT";
export const EDIT_DISABLED_TEXT = "메시지 수정은 아직 지원되지 않습니다";
export const EDIT_MAX_LENGTH = 4000;

export type EditCaps = { enabled: boolean; selfOnly: boolean };

/** Default ON: enabled unless UBM_EDIT is explicitly "0". */
export function editEnabled(env: Record<string, string | undefined> | undefined): boolean {
  return env?.[EDIT_ENV] !== "0";
}

export function editCaps(env: Record<string, string | undefined> | undefined): EditCaps {
  return { enabled: editEnabled(env), selfOnly: env?.UBM_SELF_ONLY === "1" };
}

function positiveId(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label}가 올바르지 않습니다`);
  return n;
}

export function normalizeEditText(value: unknown): string {
  if (typeof value !== "string") throw new Error("수정할 내용을 입력하세요");
  const text = value.trim();
  if (!text) throw new Error("수정할 내용을 입력하세요");
  if (text.length > EDIT_MAX_LENGTH) throw new Error(`메시지는 ${EDIT_MAX_LENGTH}자까지 보낼 수 있습니다`);
  return text;
}

export function normalizeReplyText(value: unknown): string {
  if (typeof value !== "string") throw new Error("답장 내용을 입력하세요");
  const text = value.trim();
  if (!text) throw new Error("답장 내용을 입력하세요");
  if (text.length > EDIT_MAX_LENGTH) throw new Error(`메시지는 ${EDIT_MAX_LENGTH}자까지 보낼 수 있습니다`);
  return text;
}

export type ReplyTarget = { messageId: number; senderName: string; text: string };

export function normalizeReplyTarget(value: unknown): ReplyTarget {
  const o = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const messageId = positiveId(o.messageId, "메시지");
  return {
    messageId,
    senderName: typeof o.senderName === "string" ? o.senderName : "",
    text: typeof o.text === "string" ? o.text : "",
  };
}

/** Self-only guard for the edit resend / quote reply — reuses the shared forward/notice guard. */
export function guardEditReplyTarget({
  selfOnly,
  me,
  selfRoomSeq,
  room,
}: {
  selfOnly: boolean;
  me: number;
  selfRoomSeq?: number | null;
  room: Pick<Room, "kind" | "seq" | "buddyRoomSeq"> | null;
}): void {
  if (!room) throw new Error("알 수 없는 대화방입니다");
  checkForwardTarget({ selfOnly, target: { roomSeq: apiRoomSeq(room) }, me, selfRoomSeq });
}

export type EditDeps = {
  guard: () => void;
  deleteByIds: (ids: number[]) => Promise<{ ok: true; count: number }>;
  sendText: (roomKey: string, text: string) => Promise<{ messageId?: number }>;
};

/** Edit = guard, delete the original, then resend with the "(수정됨)" + edit marker. */
export async function performEdit({
  guard,
  deleteByIds,
  sendText,
  roomKey,
  origMessageId,
  newText,
}: EditDeps & {
  roomKey: string;
  origMessageId: number;
  newText: string;
}): Promise<{ ok: true; messageId?: number }> {
  const id = positiveId(origMessageId, "메시지");
  guard(); // refuse to resend anywhere but the self room in safe mode, BEFORE deleting
  await deleteByIds([id]); // delete first; if it fails the original stays and nothing is sent
  const res = await sendText(roomKey, composeEditText(newText, id));
  return { ok: true, messageId: res.messageId };
}

/** Quote reply = one message: "> 이름: 원문…\n<reply>[[re:<msgId>]]". */
export async function performReply({
  guard,
  sendText,
  roomKey,
  target,
  replyText,
}: {
  guard: () => void;
  sendText: (roomKey: string, text: string) => Promise<{ messageId?: number }>;
  roomKey: string;
  target: ReplyTarget;
  replyText: string;
}): Promise<{ ok: true; messageId?: number }> {
  guard();
  const res = await sendText(roomKey, composeQuoteText(target.senderName, target.text, replyText, target.messageId));
  return { ok: true, messageId: res.messageId };
}
