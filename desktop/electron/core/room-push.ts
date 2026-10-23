import type { RoomKind } from "./types";

/**
 * Per-room notification toggle (v1.0.17).
 * Official client: ku(roomType) = {buddy:'chat/buddies', room:'chat/rooms', pubsub:'chat/pubsubs'}
 * PUT /api/{...}/{seq}/push?userSeq={me}&usePush=true|false with no request body.
 * Muted rooms still notify when I am @mentioned.
 */
export const ROOM_PUSH_METHOD = "PUT";
export const ROOM_PUSH_PATH = "/api/chat";

/** Room kind → path segment, exactly as the official client's ku(roomType). */
export const PATH_KIND: Record<string, string> = { buddy: "chat/buddies", room: "chat/rooms", pubsub: "chat/pubsubs" };

/** Exact path used by the official client. `usePush` is always literal true/false. */
export function roomPushPath(kind: RoomKind | string, roomSeq: number, me: number, usePush: boolean): string {
  const p = PATH_KIND[kind];
  if (!p) throw new Error(`지원하지 않는 대화방 종류입니다: ${kind}`);
  return `/api/${p}/${Number(roomSeq)}/push?userSeq=${Number(me)}&usePush=${usePush ? "true" : "false"}`;
}
export const buildRoomPushPath = roomPushPath;
export const buildRoomPushUrl = roomPushPath;
export const ROOM_PUSH = roomPushPath;

/** Pure notification decision: never notify my own message; mentions override a muted room. */
export function shouldNotify({ usePush, mentioned, isMine }: { usePush: boolean; mentioned: boolean; isMine: boolean }): boolean {
  if (isMine) return false;
  return !!usePush || !!mentioned;
}
