import { describe, expect, it, vi } from "vitest";
import {
  composeSummaryCommand, normalizeRecentN, normalizeSummaryMode, SUMMARY_DEFAULT_RECENT_N, SUMMARY_MAX_RECENT_N,
} from "../src/lib/bot-summary";
import {
  botSummaryCaps, botSummaryEnabled, guardBotSummaryTarget, normalizeSummaryRoomKey, performBotSummary,
  BOT_SUMMARY_DISABLED_TEXT,
} from "../electron/core/bot-summary";

describe("bot summary command composition (pure)", () => {
  it("builds /요약 with each mode", () => {
    expect(composeSummaryCommand("room:10", "unread")).toBe("/요약 room:10 안읽음");
    expect(composeSummaryCommand("room:10", "today")).toBe("/요약 room:10 오늘");
    expect(composeSummaryCommand("room:10", "recent", 5)).toBe("/요약 room:10 최근5");
    expect(composeSummaryCommand("buddy:2", "recent")).toBe(`/요약 buddy:2 최근${SUMMARY_DEFAULT_RECENT_N}`);
  });

  it("validates the mode and recent N", () => {
    expect(normalizeSummaryMode("unread")).toBe("unread");
    expect(normalizeSummaryMode("today")).toBe("today");
    expect(normalizeSummaryMode("recent")).toBe("recent");
    expect(() => normalizeSummaryMode("nope")).toThrow();
    expect(() => normalizeSummaryMode(undefined)).toThrow();

    expect(normalizeRecentN(1)).toBe(1);
    expect(normalizeRecentN("20")).toBe(20);
    expect(normalizeRecentN(SUMMARY_MAX_RECENT_N)).toBe(SUMMARY_MAX_RECENT_N);
    expect(() => normalizeRecentN(0)).toThrow();
    expect(() => normalizeRecentN(SUMMARY_MAX_RECENT_N + 1)).toThrow();
    expect(() => normalizeRecentN("abc")).toThrow();
  });
});

describe("bot summary caps / flag (UBM_BOT_SUMMARY=1)", () => {
  it("is off by default and on only with UBM_BOT_SUMMARY=1", () => {
    expect(botSummaryEnabled(undefined)).toBe(false);
    expect(botSummaryEnabled({})).toBe(false);
    expect(botSummaryEnabled({ UBM_BOT_SUMMARY: "0" })).toBe(false);
    expect(botSummaryEnabled({ UBM_BOT_SUMMARY: "1" })).toBe(true);
  });

  it("surfaces self-only from UBM_SELF_ONLY", () => {
    expect(botSummaryCaps({ UBM_BOT_SUMMARY: "1", UBM_SELF_ONLY: "1" })).toEqual({ enabled: true, selfOnly: true });
    expect(botSummaryCaps({ UBM_BOT_SUMMARY: "1" })).toEqual({ enabled: true, selfOnly: false });
  });
});

describe("normalizeSummaryRoomKey", () => {
  it("accepts room/buddy/pubsub keys and rejects the rest", () => {
    expect(normalizeSummaryRoomKey("  room:10  ")).toBe("room:10");
    expect(normalizeSummaryRoomKey("buddy:2")).toBe("buddy:2");
    expect(normalizeSummaryRoomKey("pubsub:7")).toBe("pubsub:7");
    expect(() => normalizeSummaryRoomKey("room:")).toThrow();
    expect(() => normalizeSummaryRoomKey("chat:1")).toThrow();
    expect(() => normalizeSummaryRoomKey(10)).toThrow();
    expect(() => normalizeSummaryRoomKey("")).toThrow();
  });
});

describe("self-only guard reuse", () => {
  const selfRoom = { kind: "buddy" as const, seq: 5, buddyRoomSeq: 99 };
  const selfRoomGroup = { kind: "room" as const, seq: 99, buddyRoomSeq: undefined };

  it("allows the 나 room and blocks in safe mode (missing self room throws)", () => {
    expect(() => guardBotSummaryTarget({ selfOnly: true, me: 5, selfRoomSeq: 99, selfRoom: selfRoom })).not.toThrow();
    expect(() => guardBotSummaryTarget({ selfOnly: true, me: 5, selfRoomSeq: 99, selfRoom: selfRoomGroup })).not.toThrow();
    expect(() => guardBotSummaryTarget({ selfOnly: true, me: 5, selfRoomSeq: 99, selfRoom: null })).toThrow();
  });

  it("does nothing when self-only is off", () => {
    expect(() => guardBotSummaryTarget({ selfOnly: false, me: 5, selfRoomSeq: 99, selfRoom: selfRoom })).not.toThrow();
  });
});

describe("performBotSummary", () => {
  it("guards then sends the composed command to the 나 room", async () => {
    const guard = vi.fn();
    const sendText = vi.fn().mockResolvedValue({ messageId: 77 });
    const res = await performBotSummary({
      guard, sendText, selfRoomKey: "buddy:1", roomKey: "room:10", mode: "unread",
    });
    expect(res).toEqual({ ok: true, messageId: 77 });
    expect(guard).toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith("buddy:1", "/요약 room:10 안읽음");
  });

  it("throws the guard error before sending", async () => {
    const guard = vi.fn(() => { throw new Error("안전 모드에서는 나에게만 전달할 수 있습니다"); });
    const sendText = vi.fn();
    await expect(performBotSummary({ guard, sendText, selfRoomKey: "buddy:1", roomKey: "room:10", mode: "today" })).rejects.toThrow();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("throws when there is no self room key", async () => {
    const guard = vi.fn();
    const sendText = vi.fn();
    await expect(performBotSummary({ guard, sendText, selfRoomKey: "", roomKey: "room:10", mode: "today" })).rejects.toThrow("나와의 대화방");
    expect(sendText).not.toHaveBeenCalled();
  });
});
