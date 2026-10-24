import { describe, expect, it } from "vitest";
import { BOT_NAMES, isBotGroupRoom, isCompanyBotRoom, pinCompanyBotRooms } from "../src/lib/bot-room";

describe("isBotGroupRoom", () => {
  it("is true only for group rooms with 유비온봇", () => {
    expect(isBotGroupRoom({ kind: "room" }, [{ name: "유비온봇" }])).toBe(true);
    expect(isBotGroupRoom({ kind: "room" }, [{ name: "  유비온봇  " }])).toBe(true);
    expect(isBotGroupRoom({ kind: "buddy" }, [{ name: "유비온봇" }])).toBe(false);
    expect(isBotGroupRoom({ kind: "pubsub" }, [{ name: "유비온봇" }])).toBe(false);
    expect(isBotGroupRoom({ kind: "unknown" }, [{ name: "유비온봇" }])).toBe(false);
    expect(isBotGroupRoom({ kind: "room" }, [{ name: "유비온봇2" }, { name: "김하늘" }])).toBe(false);
    expect(isBotGroupRoom({ kind: "room" }, [])).toBe(false);
    expect(isBotGroupRoom({ kind: "room" }, null)).toBe(false);
  });

  it("exports the bot name list", () => {
    expect(BOT_NAMES).toContain("유비온봇");
  });
});

describe("company bot room pin", () => {
  const room = (key: string, extra: Record<string, unknown> = {}) => ({ key, kind: "buddy", name: key, ...extra });

  it("matches the 유비온봇 1:1 room by name or known bot user", () => {
    expect(isCompanyBotRoom({ kind: "buddy", name: "유비온봇" })).toBe(true);
    expect(isCompanyBotRoom({ kind: "buddy", name: "  유비온봇  " })).toBe(true);
    expect(isCompanyBotRoom({ kind: "buddy", name: "다른 이름", peerUserId: 99 }, 99)).toBe(true);
    expect(isCompanyBotRoom({ kind: "room", name: "유비온봇" })).toBe(false);
    expect(isCompanyBotRoom({ kind: "buddy", name: "유비온봇2" })).toBe(false);
    expect(isCompanyBotRoom({ kind: "buddy", name: "김하늘", peerUserId: 2 }, 0)).toBe(false);
    expect(isCompanyBotRoom(null)).toBe(false);
  });

  it("keeps the bot room ahead of pins and newer messages", () => {
    const rooms = [
      room("pin", { usePin: true, name: "고정" }),
      room("new", { name: "최근" }),
      room("bot", { name: "유비온봇" }),
      room("peer", { name: "봇계정", peerUserId: 99 }),
    ];
    expect(pinCompanyBotRooms(rooms, 99).map((r) => r.key)).toEqual(["bot", "peer", "pin", "new"]);
    expect(pinCompanyBotRooms(rooms, 99)).not.toBe(rooms);
    const already = [room("bot", { name: "유비온봇" }), room("pin", { name: "고정" })];
    expect(pinCompanyBotRooms(already)).toBe(already);
    expect(pinCompanyBotRooms([room("a"), room("b")])).toEqual([room("a"), room("b")]);
  });
});
