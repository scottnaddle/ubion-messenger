import { api } from "../api";
import type { MentionMember } from "./mention";

/** Room member as returned to the renderer, including the profile image used for avatars. */
export type RoomMemberFace = MentionMember & { image?: string };

const memberCache = new Map<string, RoomMemberFace[]>();
const memberPending = new Map<string, Promise<RoomMemberFace[]>>();

/** The room list can ask for every group at once; keep the members API to a few in flight. */
const MAX_INFLIGHT = 4;
let inflight = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (inflight < MAX_INFLIGHT) {
    inflight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      inflight++;
      resolve();
    });
  });
}

function release() {
  inflight = Math.max(0, inflight - 1);
  const next = waiters.shift();
  if (next) next();
}

export function peekRoomMembers(roomKey: string): RoomMemberFace[] | undefined {
  return memberCache.get(roomKey);
}

/**
 * Fetch room members once per room. Group rooms only (`rooms:members` is empty otherwise).
 * Failures are not cached, so a transient error can be retried.
 */
export function loadRoomMembers(roomKey: string): Promise<RoomMemberFace[]> {
  const cached = memberCache.get(roomKey);
  if (cached) return Promise.resolve(cached);
  const pending = memberPending.get(roomKey);
  if (pending) return pending;
  const req = acquire().then(() => api().call<RoomMemberFace[]>("rooms:members", roomKey))
    .then((list) => {
      const members = (Array.isArray(list) ? list : [])
        .filter((m) => m && typeof m.name === "string" && m.name)
        .map((m) => ({
          userId: Number(m.userId), name: m.name,
          position: m.position || "", department: m.department || "", image: m.image || "",
        }));
      memberCache.set(roomKey, members);
      return members;
    })
    .catch(() => [] as RoomMemberFace[])
    .finally(() => {
      memberPending.delete(roomKey);
      release();
    });
  memberPending.set(roomKey, req);
  return req;
}
