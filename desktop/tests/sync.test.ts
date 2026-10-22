import { describe, expect, it } from "vitest";
import { MessengerCore, newerThan } from "../electron/core/messenger";
import type { ChatMessage, Room } from "../electron/core/types";

const msg = (id: number, from: number, text = "t"): ChatMessage => ({
  messageId: id, sendUserSeq: from, sendUserName: "", message: text, userImage: "", createdAt: new Date(1e12 + id).toISOString(),
});
const room = (seq: number, mid: number): Room => ({
  key: `buddy:${seq}`, kind: "buddy", seq, name: "r", preview: "", messageId: mid, unread: 0, usePin: false, usePush: true,
  avatar: "", isSelf: false, createdAt: new Date(1e12 + mid).toISOString(),
});

function fakeCore(state: { rooms: Room[]; msgs: Record<string, ChatMessage[]> }) {
  const core = new MessengerCore("https://example.invalid");
  core.client.user = { id: 1, repId: 1, name: "me", loginId: "me" };
  core.client.listRooms = async () => state.rooms.map((r) => ({ ...r }));
  core.client.fetchMessages = async (kind, seq) => state.msgs[`${kind}:${seq}`] || [];
  const got: Array<ChatMessage & { isMine: boolean; roomKey: string }> = [];
  core.on("message", (m) => got.push(m));
  return { core, got };
}

describe("REST sync fallback", () => {
  it("newerThan filters and sorts", () => {
    expect(newerThan([msg(5, 1), msg(3, 1), msg(4, 1)], 3).map((m) => m.messageId)).toEqual([4, 5]);
  });

  it("emits messages missed by XMPP for the open room, incl. own messages from other clients, once", async () => {
    const state = { rooms: [room(2, 10)], msgs: { "buddy:2": [msg(9, 2), msg(10, 1)] } as Record<string, ChatMessage[]> };
    const { core, got } = fakeCore(state);
    await core.refreshRooms();
    core.setActiveRoom("buddy:2");
    core.noteSeen("buddy:2", state.msgs["buddy:2"]); // UI loaded history
    // colleague message + my reply from the official app arrive only on the server
    state.msgs["buddy:2"] = [msg(9, 2), msg(10, 1), msg(11, 2), msg(12, 1)];
    state.rooms = [room(2, 12)];
    await core.sync();
    expect(got.map((m) => [m.messageId, m.isMine])).toEqual([[11, false], [12, true]]);
    expect(core.getRooms()[0].messageId).toBe(12);
    await core.sync(); // no duplicates
    expect(got).toHaveLength(2);
    core.shutdown();
  });

  it("emits new messages for a background room whose latest id advanced, without replaying history", async () => {
    const state = { rooms: [room(2, 10), room(3, 20)], msgs: { "buddy:3": [msg(19, 3), msg(20, 3)] } as Record<string, ChatMessage[]> };
    const { core, got } = fakeCore(state);
    await core.sync(); // baseline only
    expect(got).toHaveLength(0);
    state.rooms = [room(2, 10), room(3, 21)];
    state.msgs["buddy:3"] = [msg(19, 3), msg(20, 3), msg(21, 3)];
    await core.sync();
    expect(got.map((m) => m.messageId)).toEqual([21]);
    expect(got[0].roomKey).toBe("buddy:3");
    core.shutdown();
  });

  it("does not double-emit a message already delivered via XMPP", async () => {
    const state = { rooms: [room(2, 10)], msgs: { "buddy:2": [msg(10, 2)] } as Record<string, ChatMessage[]> };
    const { core, got } = fakeCore(state);
    await core.refreshRooms();
    core.setActiveRoom("buddy:2");
    core.noteSeen("buddy:2", state.msgs["buddy:2"]);
    (core as any).onBody({ type: "message", subtype: "single", from: { userSeq: 2 }, toSeq: 1, message: "x", messageId: 11 });
    state.msgs["buddy:2"] = [msg(10, 2), msg(11, 2)];
    state.rooms = [room(2, 11)];
    await core.sync();
    expect(got.map((m) => m.messageId)).toEqual([11]);
    core.shutdown();
  });

  it("handles carbon-wrapped stanzas (body nested in <sent>/<forwarded>)", async () => {
    const { XmppClient } = await import("../electron/core/xmpp");
    const x = new XmppClient({ host: "h", port: 1, domain: "d", username: "u", password: "p", resource: "r" });
    const bodies: any[] = [];
    x.on("body", (b) => bodies.push(b));
    (x as any).handleOnline(
      `<message to='1@d/r'><sent xmlns='urn:xmpp:carbons:2'><forwarded xmlns='urn:xmpp:forward:0'><message from='1@d/go_pc_1_5' to='2@d'><body>{&quot;type&quot;:&quot;message&quot;,&quot;subtype&quot;:&quot;single&quot;,&quot;messageId&quot;:7}</body></message></forwarded></sent></message>`
    );
    expect(bodies[0].messageId).toBe(7);
  });
});

describe("live stanza shape", () => {
  it("emits a 'chat'-typed 1:1 push (incl. own message from another client) exactly once", () => {
    const core = new MessengerCore("https://example.invalid");
    core.client.user = { id: 1, repId: 1, name: "me", loginId: "me" };
    core.client.listRooms = async () => [];
    const got: any[] = [];
    core.on("message", (m) => got.push(m));
    const body = { type: "chat", subtype: "single", from: { userSeq: 1 }, toSeq: 2, message: "x", messageId: 50 };
    (core as any).onBody(body);
    (core as any).onBody(body); // carbon copy duplicate
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ roomKey: "buddy:2", isMine: true, messageId: 50 });
    core.shutdown();
  });
});
