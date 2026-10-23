import type { Room } from "./types";

export const FORWARD_ROOM_PATH = "/api/chat/forward/attaches/room";
export const FORWARD_MEMBERS_PATH = "/api/chat/forward/attaches";
export const FORWARD_METHOD = "POST";
export const FORWARD_MAX_MEMBERS = 150;
export const FORWARD_SUCCESS_TEXT = "전달되었습니다.";

export type ForwardRoomType = "single" | "group";

/**
 * Room id used by the forward/notice APIs: zo(room) = buddyRoomSeq || roomSeq || pubsubSeq.
 * For buddy rooms our Room.seq is the peer user id, so it must never be sent to these endpoints.
 */
export function apiRoomSeq(room: Pick<Room, "kind" | "seq" | "buddyRoomSeq">): number {
  const seq = room.kind === "buddy" ? room.buddyRoomSeq : room.seq;
  if (seq == null || !Number.isSafeInteger(Number(seq)) || Number(seq) <= 0)
    throw new Error("대화방 번호를 확인할 수 없습니다");
  return Number(seq);
}

function positiveSeq(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label}가 올바르지 않습니다`);
  return n;
}

function cryptIdOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    for (const raw of [v.cryptId, v.cryptAttachText, v.fileId, v.attachId]) {
      if (typeof raw === "string" && raw.trim()) return raw.trim();
    }
  }
  return "";
}

export function cryptAttachTexts(attaches: unknown): string[] {
  const list = Array.isArray(attaches) ? attaches : [];
  const out = list.map(cryptIdOf).filter(Boolean);
  if (!out.length) throw new Error("전달할 파일이 없습니다");
  return out;
}

export function normalizeForwardCryptIds(cryptIds: unknown): string[] {
  return cryptAttachTexts(cryptIds);
}

export function normalizeForwardRoomType(roomType: unknown): ForwardRoomType {
  const type = String(roomType || "").trim().toLowerCase();
  if (type !== "single" && type !== "group") throw new Error("올바른 전송 방식을 선택하세요");
  return type;
}

export function normalizeForwardMembers(memberSeqs: unknown): number[] {
  const list = Array.isArray(memberSeqs) ? memberSeqs : [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const value of list) {
    const n = positiveSeq(value, "대상");
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  if (!out.length) throw new Error("전달할 대상을 선택하세요");
  if (out.length > FORWARD_MAX_MEMBERS) throw new Error(`한 번에 최대 ${FORWARD_MAX_MEMBERS}명까지 전달할 수 있습니다`);
  return out;
}

export function forwardRoomPath(roomSeq: unknown, cryptIds: unknown, me: unknown): string {
  const room = positiveSeq(roomSeq, "대화방");
  const uid = positiveSeq(me, "사용자");
  const ids = cryptAttachTexts(cryptIds);
  // Every value is encodeURIComponent'd; the original renderer concatenated raw cryptIds.
  const query = [
    `roomSeq=${encodeURIComponent(String(room))}`,
    ...ids.map((id) => `cryptAttachText=${encodeURIComponent(id)}`),
    `userSeq=${encodeURIComponent(String(uid))}`,
  ].join("&");
  return `${FORWARD_ROOM_PATH}?${query}`;
}

export function forwardMembersPath(memberSeqs: unknown, cryptIds: unknown, roomType: unknown, me: unknown): string {
  const type = normalizeForwardRoomType(roomType);
  const members = normalizeForwardMembers(memberSeqs);
  const uid = positiveSeq(me, "사용자");
  const ids = cryptAttachTexts(cryptIds);
  const query = [
    `roomType=${encodeURIComponent(type)}`,
    ...members.map((seq) => `memberSeq=${encodeURIComponent(String(seq))}`),
    ...ids.map((id) => `cryptAttachText=${encodeURIComponent(id)}`),
    `userSeq=${encodeURIComponent(String(uid))}`,
  ].join("&");
  return `${FORWARD_MEMBERS_PATH}?${query}`;
}

export type ForwardTarget =
  | number
  | number[]
  | {
      roomSeq?: number;
      seq?: number;
      memberSeqs?: number[];
      members?: number[];
      memberSeq?: number;
    };

function targetSeqs(target: ForwardTarget): { roomSeq?: number; members?: number[] } {
  if (typeof target === "number") return { roomSeq: target };
  if (Array.isArray(target)) return { members: target };
  const roomSeq = target?.roomSeq ?? target?.seq;
  const members = target?.memberSeqs ?? target?.members ?? (target?.memberSeq != null ? [target.memberSeq] : undefined);
  return { roomSeq, members };
}

/** Safety guard used by the main process. When enabled only the memo-to-self room/[me] is allowed. */
export function checkForwardTarget({
  selfOnly,
  target,
  me,
  selfRoomSeq,
}: {
  selfOnly: boolean;
  target: ForwardTarget;
  me: number;
  selfRoomSeq?: number | null;
}): void {
  if (!selfOnly) return;
  const uid = Number(me);
  const selfRoom = selfRoomSeq == null ? undefined : Number(selfRoomSeq);
  const { roomSeq, members } = targetSeqs(target);
  if (roomSeq != null && selfRoom != null && Number(roomSeq) === selfRoom) return;
  const unique = [...new Set((members || []).map(Number))];
  if (unique.length === 1 && unique[0] === uid) return;
  throw new Error("안전 모드에서는 나에게만 전달할 수 있습니다");
}
