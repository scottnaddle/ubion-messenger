import { describe, expect, it } from "vitest";
import { splitStanzas, xmlUnescape } from "../electron/core/xmpp";
import { parsePresence, routeXmppBody, MessengerCore } from "../electron/core/messenger";
import { xmppKeyFromLoginId } from "../electron/core/xmpp-key";
import { canonMessageId, dedupeByMessageId, upsertMessage } from "../electron/core/messages";
import { normalizeRestMessage, sortRooms } from "../electron/core/daou-client";
import { isSendEnter } from "../src/lib/composer";
import type { ChatMessage, Room } from "../electron/core/types";

describe("xmpp framing", () => {
  it("splits complete stanzas and keeps partial rest", () => {
    const buf = `<?xml version='1.0'?><stream:stream from='x' id='1'><stream:features><mechanisms><mechanism>PLAIN</mechanism></mechanisms></stream:features><presence from='5@d/r'/><message from='a'><body>{&quot;a&quot;:1}</body></mess`;
    const { stanzas, rest } = splitStanzas(buf);
    expect(stanzas[0]).toMatch(/^<stream:stream/);
    expect(stanzas[1]).toMatch(/^<stream:features>.*<\/stream:features>$/);
    expect(stanzas[2]).toBe("<presence from='5@d/r'/>");
    expect(rest).toMatch(/^<message/);
    const r2 = splitStanzas(rest + "age>");
    expect(r2.stanzas).toHaveLength(1);
    expect(r2.rest).toBe("");
  });
  it("handles nested same-name tags", () => {
    const { stanzas } = splitStanzas("<message><message>x</message></message><iq/>");
    expect(stanzas).toEqual(["<message><message>x</message></message>", "<iq/>"]);
  });
  it("unescapes entities", () => {
    expect(xmlUnescape("&lt;b&gt; &amp;amp; &#54620;")).toBe("<b> &amp; 한");
  });
});

describe("routing", () => {
  const me = 312;
  it("routes single message from peer to buddy:peer", () => {
    const r = routeXmppBody({ type: "message", subtype: "single", from: { userSeq: 229, userName: "A" }, toSeq: 312, message: "hi", messageId: "77" }, me);
    expect(r.kind).toBe("buddy");
    expect(r.seq).toBe(229);
    expect(r.msg.messageId).toBe(77);
    expect(r.isMine).toBe(false);
  });
  it("treats server JSON type 'chat' (observed live) as a chat message", () => {
    const r = routeXmppBody({ type: "chat", subtype: "single", from: { userSeq: 229 }, toSeq: 312, message: "hi", messageId: 5 }, me);
    expect(r.isChat).toBe(true);
    expect([r.kind, r.seq]).toEqual(["buddy", 229]);
    expect(routeXmppBody({ type: "noti" }, me).isChat).toBe(false);
    expect(routeXmppBody({ type: "confirm", subtype: "single" }, me).isChat).toBe(false);
  });
  it("routes my own echo to the peer room", () => {
    const r = routeXmppBody({ type: "message", subtype: "single", from: { userSeq: 312 }, toSeq: 229, message: "x" }, me);
    expect(r.seq).toBe(229);
    expect(r.isMine).toBe(true);
  });
  it("routes group by toSeq", () => {
    const r = routeXmppBody({ type: "message", subtype: "group", from: { userSeq: 5 }, toSeq: 900, message: "x" }, me);
    expect([r.kind, r.seq]).toEqual(["room", 900]);
  });
  it("adds timestamp fallback", () => {
    const r = routeXmppBody({ type: "message", subtype: "single", from: { userSeq: 1 }, message: "x" }, me);
    expect(Number.isNaN(new Date(r.msg.createdAt!).getTime())).toBe(false);
  });
  it("parses presence", () => {
    expect(parsePresence(undefined, "online:on")).toBe("online");
    expect(parsePresence(undefined, "away:on")).toBe("away");
    expect(parsePresence("unavailable", "terminated")).toBe("offline");
  });
});

describe("messages", () => {
  it("xmpp key derivation is deterministic 10 chars", () => {
    expect(xmppKeyFromLoginId("abc")).toHaveLength(10);
    expect(xmppKeyFromLoginId("abc")).toBe(xmppKeyFromLoginId("abc"));
  });
  it("canon ids + dedupe REST number vs XMPP string", () => {
    expect(canonMessageId("18116599")).toBe(18116599);
    const list: ChatMessage[] = [{ messageId: 5, message: "a", sendUserName: "", userImage: "", createdAt: new Date().toISOString() }];
    const out = upsertMessage(list, { messageId: "5" as unknown as number, message: "a", sendUserName: "", userImage: "" });
    expect(out).toHaveLength(1);
    expect(dedupeByMessageId([...list, ...list])).toHaveLength(1);
  });
  it("reconciles optimistic message with echo", () => {
    const opt: ChatMessage = { clientId: "c1", message: "안녕", sendUserSeq: 1, sendUserName: "", userImage: "", pending: true, createdAt: new Date().toISOString() };
    const out = upsertMessage([opt], { messageId: 9, message: "안녕", sendUserSeq: 1, sendUserName: "", userImage: "" });
    expect(out).toHaveLength(1);
    expect(out[0].pending).toBe(false);
    expect(out[0].messageId).toBe(9);
  });
  it("normalizes REST attach", () => {
    const m = normalizeRestMessage({ messageId: 1, messageType: "SENDFILE", chatMessageAttachFileModel: { cryptId: "c", name: "a.png", imageFile: true, size: 3 } });
    expect(m.attach?.cryptId).toBe("c");
    expect(m.attach?.imageFile).toBe(true);
  });
  it("sorts pinned then recent", () => {
    const base = { kind: "buddy", seq: 1, name: "", preview: "", unread: 0, usePush: true, avatar: "", isSelf: false } as const;
    const rs: Room[] = [
      { ...base, key: "a", usePin: false, createdAt: "2026-10-01T00:00:00+09:00" },
      { ...base, key: "b", usePin: false, createdAt: "2026-10-02T00:00:00+09:00" },
      { ...base, key: "c", usePin: true, createdAt: "2020-01-01T00:00:00+09:00" },
    ];
    expect(sortRooms(rs).map((r) => r.key)).toEqual(["c", "b", "a"]);
  });
});

describe("realtime file attach reconciliation", () => {
  it("re-emits a SENDFILE body that arrived without attach after syncRoom", async () => {
    const core = new MessengerCore("https://example.invalid");
    core.client.user = { id: 1, repId: 1, name: "me", loginId: "me" };
    const room: Room = {
      key: "buddy:2", kind: "buddy", seq: 2, name: "peer", preview: "", messageId: 11, unread: 0,
      usePin: false, usePush: true, avatar: "", isSelf: false, createdAt: new Date(1e12 + 11).toISOString(),
    };
    core.client.listRooms = async () => [{ ...room }];
    const base: ChatMessage = {
      messageId: 11, sendUserSeq: 2, sendUserName: "peer", message: "", userImage: "",
      createdAt: new Date(1e12 + 11).toISOString(), messageType: "SENDFILE",
    };
    let page: ChatMessage[] = [{ ...base }];
    core.client.fetchMessages = async () => page.map((m) => ({ ...m }));
    await core.refreshRooms();
    const got: ChatMessage[] = [];
    core.on("message", (m) => got.push(m));
    (core as any).onBody({ type: "message", subtype: "single", from: { userSeq: 2 }, toSeq: 1, message: "", messageId: 11, messageType: "SENDFILE" });
    expect(got).toHaveLength(1);
    expect(got[0].attach).toBeUndefined();
    page = [{ ...base, attach: { cryptId: "c1", name: "a.png", imageFile: true } }];
    await core.syncRoom("buddy:2");
    expect(got).toHaveLength(2);
    expect(got[1]).toMatchObject({ messageId: 11, roomKey: "buddy:2", isMine: false });
    expect(got[1].attach?.cryptId).toBe("c1");
    expect(core.getRooms()[0].preview).toBe("📎 a.png");
    core.shutdown();
  });
});

describe("IME-safe Enter", () => {
  it("never sends while composing", () => {
    expect(isSendEnter({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(isSendEnter({ key: "Enter", shiftKey: false, keyCode: 229 })).toBe(false);
    expect(isSendEnter({ key: "Enter", shiftKey: false, composingRef: true })).toBe(false);
    expect(isSendEnter({ key: "Enter", shiftKey: true })).toBe(false);
    expect(isSendEnter({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 })).toBe(true);
  });
});
