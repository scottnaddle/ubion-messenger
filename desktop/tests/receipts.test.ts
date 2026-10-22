import { describe, expect, it } from "vitest";
import { MessengerCore, initialNeedConfirm, routeXmppBody } from "../electron/core/messenger";
import { applyReadReceipt, mergeReceipts, roomMatchesFilter } from "../electron/core/messages";
import { normalizeRestMessage, DaouClient } from "../electron/core/daou-client";
import type { ChatMessage, Room } from "../electron/core/types";

const ME = 312, PEER = 229;
// Sanitized captures of live XMPP confirm bodies (2026-10-22): ids/types kept, everything else stripped.
const CONFIRM_PEER_READ_MINE = { type: "confirm", subtype: "single", actiontype: "", deletedType: "", usePush: true,
  from: { userSeq: PEER }, senderSeq: ME, toSeq: PEER, toUserRoomId: 1, messageId: 18118527,
  confirmedBeginMessageId: 18118500, confirmedEndMessageId: 18118527 };
const CONFIRM_I_READ_ELSEWHERE = { type: "confirm", subtype: "single", actiontype: "", deletedType: "", usePush: true,
  from: { userSeq: ME }, senderSeq: PEER, toSeq: ME, toUserRoomId: 1, messageId: 18118614,
  confirmedBeginMessageId: 18118614, confirmedEndMessageId: 18118614 };

const m = (id: number, from: number, need: number, confirmUsers: number[] = []): ChatMessage => ({
  messageId: id, sendUserSeq: from, sendUserName: "", message: "", userImage: "", needConfirmCount: need, confirmUsers,
});

describe("confirm routing (official semantics)", () => {
  it("peer read my messages → room buddy:peer, reader = peer, range end", () => {
    const r = routeXmppBody(CONFIRM_PEER_READ_MINE, ME);
    expect(r.receipt).toEqual({ roomKey: `buddy:${PEER}`, readerSeq: PEER, beginId: 18118500, endId: 18118527 });
  });
  it("I read on another client → room of senderSeq, reader = me", () => {
    const r = routeXmppBody(CONFIRM_I_READ_ELSEWHERE, ME);
    expect(r.receipt?.roomKey).toBe(`buddy:${PEER}`);
    expect(r.receipt?.readerSeq).toBe(ME);
  });
  it("group confirm routes by toSeq", () => {
    const r = routeXmppBody({ type: "confirm", subtype: "group", from: { userSeq: 7 }, toSeq: 900, confirmedEndMessageId: 50 }, ME);
    expect(r.receipt).toMatchObject({ roomKey: "room:900", readerSeq: 7, endId: 50 });
  });
});

describe("applyReadReceipt", () => {
  it("1:1: my '1' disappears when peer reads", () => {
    const out = applyReadReceipt([m(10, ME, 1), m(11, ME, 1)], { readerSeq: PEER, endId: 11 });
    expect(out.map((x) => x.needConfirmCount)).toEqual([0, 0]);
  });
  it("group: count decreases once per reader, never for the sender itself, respects endId", () => {
    let l = [m(10, ME, 3), m(11, 5, 3, [ME]), m(12, ME, 3)];
    l = applyReadReceipt(l, { readerSeq: 5, endId: 11 });
    expect(l.map((x) => x.needConfirmCount)).toEqual([2, 3, 3]); // 11 sent by reader; 12 > endId
    l = applyReadReceipt(l, { readerSeq: 5, endId: 12 });
    expect(l.map((x) => x.needConfirmCount)).toEqual([2, 3, 2]); // no double count for 10
    l = applyReadReceipt(l, { readerSeq: 6 });
    expect(l.map((x) => x.needConfirmCount)).toEqual([1, 2, 1]);
  });
  it("REST merge only lowers counts", () => {
    const l = mergeReceipts([m(10, ME, 1), m(11, ME, 3)], [{ messageId: 10, needConfirmCount: 1, confirmUsers: [] }, { messageId: 11, needConfirmCount: 0, confirmUsers: [5] }]);
    expect(l.map((x) => x.needConfirmCount)).toEqual([1, 0]);
    expect(mergeReceipts([m(10, ME, 0)], [{ messageId: 10, needConfirmCount: 1, confirmUsers: [] }])[0].needConfirmCount).toBe(0);
  });
  it("normalizes REST confirmUsers ints", () => {
    expect(normalizeRestMessage({ messageId: 1, needConfirmCount: 1, confirmUsers: [312, "5"] }).confirmUsers).toEqual([312, 5]);
  });
  it("initial count for realtime messages matches official getNeedConfirmCount", () => {
    expect(initialNeedConfirm("buddy", PEER, ME)).toBe(1);
    expect(initialNeedConfirm("buddy", ME, ME)).toBe(0);
    expect(initialNeedConfirm("room", 9, ME, { memberCount: 21 } as Room)).toBe(20);
    expect(initialNeedConfirm("pubsub", 9, ME)).toBe(0);
  });
});

describe("rooms: types, filters, unread", () => {
  const c = new DaouClient();
  c.user = { id: ME, repId: ME, name: "", loginId: "" };
  // sanitized shapes of the 4 live room variants
  const single = c.normalizeRoom({ buddySeq: PEER, buddyRoomType: "single", unreadMessageCount: 2, messageId: 5 });
  const my = c.normalizeRoom({ buddySeq: ME, buddyRoomType: "my", unreadMessageCount: 0 });
  const group = c.normalizeRoom({ roomSeq: 900, roomType: "group", memberCount: 21, joinYn: "Y", unreadMessageCount: 3 });
  const pubsub = c.normalizeRoom({ pubsubSeq: 7, roomType: "pubsub", joinYn: "Y", unreadMessageCount: 1 });
  it("classifies like the official app", () => {
    expect([single.kind, my.kind, group.kind, pubsub.kind]).toEqual(["buddy", "buddy", "room", "pubsub"]);
    expect(my.isSelf).toBe(true);
    expect(single.isSelf).toBe(false);
  });
  it("filter tabs", () => {
    const all = [single, my, group, pubsub];
    expect(all.filter((r) => roomMatchesFilter(r, "dm")).map((r) => r.key)).toEqual([single.key, my.key]);
    expect(all.filter((r) => roomMatchesFilter(r, "group")).map((r) => r.key)).toEqual([group.key]);
    expect(all.filter((r) => roomMatchesFilter(r, "unread")).length).toBe(3);
  });
  it("badge total = sum of server unread counts (muted included); confirm by me clears a room", async () => {
    const core = new MessengerCore("https://example.invalid");
    core.client.user = { id: ME, repId: ME, name: "", loginId: "" };
    core.client.listRooms = async () => [{ ...single }, { ...group, usePush: false }, { ...pubsub }];
    core.client.fetchMessages = async () => [];
    await core.refreshRooms();
    expect(core.unreadTotal()).toBe(6);
    (core as any).onBody(CONFIRM_I_READ_ELSEWHERE);
    expect(core.getRooms().find((r) => r.key === `buddy:${PEER}`)!.unread).toBe(0);
    expect(core.unreadTotal()).toBe(4);
    // new message from peer while not viewing → +1, carbon duplicate ignored
    const body = { type: "chat", subtype: "single", from: { userSeq: PEER }, toSeq: ME, messageId: 99, message: "" };
    (core as any).onBody(body);
    (core as any).onBody(body);
    expect(core.unreadTotal()).toBe(5);
    core.shutdown();
  });
});
