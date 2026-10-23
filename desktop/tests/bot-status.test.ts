import { describe, expect, it } from "vitest";
import { handleOnlineStanza } from "../electron/core/xmpp";
import {
  applyBotStatus, botStatusLabel, clearBotStatusForMessage, expireBotStatuses, parseBotStatus,
  type BotStatusMap, type BotStatusUpdate,
} from "../src/lib/bot-status";

function run(stanza: string) {
  const events: Array<{ event: string; payload: any }> = [];
  handleOnlineStanza(stanza, {
    write: () => undefined,
    domain: "xmppdaou.com",
    emit: (event, payload) => events.push({ event, payload }),
  });
  return events;
}

describe("bot status stanzas", () => {
  it("parses double-quoted, non-self-closing stanzas", () => {
    const events = run(
      `<message type="chat" from="1247@xmppdaou.com/res" to="312@xmppdaou.com/x" id="bs-1">` +
      `<composing xmlns="http://jabber.org/protocol/chatstates"></composing>` +
      `<bot-status xmlns="urn:ubion:bot-status" state="thinking" room="room:123">생각 중</bot-status>` +
      `<no-store xmlns="urn:xmpp:hints"></no-store></message>`
    );
    expect(events).toEqual([{
      event: "botStatus",
      payload: { local: "1247", state: "thinking", text: "생각 중", room: "room:123" },
    }]);
  });

  it("parses single-quoted, self-closing done stanzas", () => {
    const events = run(
      `<message type='chat' from='8@d/r'><bot-status xmlns='urn:ubion:bot-status' state='done'/></message>`
    );
    expect(events).toEqual([{
      event: "botStatus",
      payload: { local: "8", state: "done", text: "", room: undefined },
    }]);
  });

  it("unescapes, trims and caps text at 60 characters", () => {
    const long = "가".repeat(70);
    expect(parseBotStatus(
      `<message from="5@d/r"><bot-status xmlns="urn:ubion:bot-status" state="working">  a &amp; b  </bot-status></message>`,
      (s) => s.replace(/&amp;/g, "&"),
    )?.text).toBe("a & b");
    expect(parseBotStatus(
      `<message from="5@d/r"><bot-status xmlns="urn:ubion:bot-status" state="working">${long}</bot-status></message>`
    )?.text).toHaveLength(60);
    expect(Array.from(parseBotStatus(
      `<message from="5@d/r"><bot-status xmlns="urn:ubion:bot-status" state="working">${"😀".repeat(70)}</bot-status></message>`
    )!.text)).toHaveLength(60);
  });

  it("ignores statuses with an invalid room, state, or no from", () => {
    const badRoom = `<message from="5@d/r"><bot-status xmlns="urn:ubion:bot-status" state="thinking" room="room:x">x</bot-status></message>`;
    const badState = `<message from="5@d/r"><bot-status xmlns="urn:ubion:bot-status" state="idle">x</bot-status></message>`;
    const noFrom = `<message><bot-status xmlns="urn:ubion:bot-status" state="thinking">x</bot-status></message>`;
    expect(run(badRoom)).toEqual([]);
    expect(run(badState)).toEqual([]);
    expect(run(noFrom)).toEqual([]);
  });

  it("leaves body messages unchanged", () => {
    const events = run(
      `<message from="1@d/r"><body>{"type":"message","messageId":9}</body>` +
      `<bot-status xmlns="urn:ubion:bot-status" state="working">x</bot-status></message>`
    );
    expect(events).toEqual([{ event: "body", payload: { type: "message", messageId: 9 } }]);
  });

  it("ignores body-less messages without a bot status", () => {
    expect(run(`<message from="1@d/r"><composing xmlns="http://jabber.org/protocol/chatstates"/></message>`)).toEqual([]);
  });
});

describe("bot status reducer", () => {
  const update: BotStatusUpdate = { roomKey: "buddy:5", userId: 5, state: "thinking", text: "생각 중" };

  it("applies statuses and clears on done", () => {
    const map = applyBotStatus({}, update, 1000);
    expect(map["buddy:5"]).toEqual({ ...update, at: 1000 });
    const working = applyBotStatus(map, { ...update, state: "working", text: "" }, 2000);
    expect(working["buddy:5"]).toMatchObject({ state: "working", text: "", at: 2000 });
    expect(applyBotStatus(working, { ...update, state: "done" }, 3000)).toEqual({});
  });

  it("ignores done from a different author", () => {
    const map = applyBotStatus({}, update, 1000);
    expect(applyBotStatus(map, { ...update, userId: 6, state: "done" }, 2000)).toBe(map);
  });

  it("clears only when the status author sends a message", () => {
    const map = applyBotStatus({}, update, 1000);
    expect(clearBotStatusForMessage(map, "buddy:5", 6)).toBe(map);
    expect(clearBotStatusForMessage(map, "buddy:5", 5)).toEqual({});
  });

  it("expires 60s after the last status", () => {
    const map: BotStatusMap = applyBotStatus({}, update, 1000);
    expect(expireBotStatuses(map, 1000 + 59_999)).toBe(map);
    expect(expireBotStatuses(map, 1000 + 60_000)).toEqual({});
  });

  it("uses Korean labels when text is empty", () => {
    expect(botStatusLabel("thinking", "")).toBe("생각 중");
    expect(botStatusLabel("working", "")).toBe("작업 중");
    expect(botStatusLabel("thinking", "검토 중")).toBe("검토 중");
  });
});
