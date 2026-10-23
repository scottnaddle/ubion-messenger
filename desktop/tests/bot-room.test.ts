import { describe, expect, it } from "vitest";
import { BOT_NAMES, isBotGroupRoom } from "../src/lib/bot-room";

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
