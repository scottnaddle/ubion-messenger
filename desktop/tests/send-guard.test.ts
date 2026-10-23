import { describe, expect, it } from "vitest";
import { apiRoomSeq, checkForwardTarget } from "../electron/core/forward";
import type { Room } from "../electron/core/types";

/**
 * Normal send path guard. The quote reply is composed in the renderer and sent through msg:send,
 * so main.ts guards that handler with `guardedRoomSeq(key)` when UBM_SELF_ONLY=1 — exactly the same
 * checkForwardTarget + apiRoomSeq composition every other send path uses. This test locks that
 * behaviour for the room shapes a real send encounters (memo-to-self buddy room, group room, pubsub).
 */
const selfRoom: Room = {
  key: "buddy:42", kind: "buddy", seq: 42, buddyRoomSeq: 777, name: "나", preview: "",
  unread: 0, usePin: false, usePush: true, avatar: "", isSelf: true, peerUserId: 42,
};
const groupRoom: Room = {
  key: "room:9", kind: "room", seq: 9, name: "팀", preview: "",
  unread: 0, usePin: false, usePush: true, avatar: "", isSelf: false,
};
const pubsubRoom: Room = {
  key: "pubsub:3", kind: "pubsub", seq: 3, name: "공지", preview: "",
  unread: 0, usePin: false, usePush: true, avatar: "", isSelf: false,
};

const sendGuard = (selfOnly: boolean, room: Room | null) => {
  if (!room) throw new Error("알 수 없는 대화방입니다");
  checkForwardTarget({ selfOnly, target: { roomSeq: apiRoomSeq(room) }, me: 42, selfRoomSeq: apiRoomSeq(selfRoom) });
};

describe("normal send / quote-reply self-only guard", () => {
  it("allows sending to the memo-to-self room in safe mode", () => {
    expect(() => sendGuard(true, selfRoom)).not.toThrow();
  });

  it("refuses text/quote sends to a group room in safe mode", () => {
    expect(() => sendGuard(true, groupRoom)).toThrow("안전 모드에서는 나에게만 전달할 수 있습니다");
  });

  it("refuses text/quote sends to a pubsub room in safe mode", () => {
    expect(() => sendGuard(true, pubsubRoom)).toThrow("안전 모드에서는 나에게만 전달할 수 있습니다");
  });

  it("does not block any send when safe mode is off", () => {
    expect(() => sendGuard(false, groupRoom)).not.toThrow();
    expect(() => sendGuard(false, pubsubRoom)).not.toThrow();
    expect(() => sendGuard(false, selfRoom)).not.toThrow();
  });

  it("throws on a missing room before the guard (same as guardedRoomSeq)", () => {
    expect(() => sendGuard(true, null)).toThrow("알 수 없는 대화방입니다");
  });
});
