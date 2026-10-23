import { describe, expect, it, vi } from "vitest";
import {
  createReactionsClient, guardReactionRoom, normalizeEmoji, normalizeMessageId, normalizeMessageIds,
  normalizeRoomSeq, parseReactions, reactionsCaps, reactionsEnabled,
} from "../electron/core/reactions";
import { applyToggle, reactionChips } from "../src/lib/reactions";

const ok = (body: unknown, status = 200) => ({
  status,
  text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  headers: { get: () => null },
});

describe("reactions caps / normalization", () => {
  it("is enabled only with UBM_REACTIONS=1", () => {
    expect(reactionsEnabled({ UBM_REACTIONS: "1" })).toBe(true);
    expect(reactionsEnabled({})).toBe(false);
    expect(reactionsEnabled(undefined)).toBe(false);
    expect(reactionsCaps({ UBM_REACTIONS: "1" })).toEqual({ enabled: true });
  });

  it("validates seq/emoji inputs", () => {
    expect(normalizeRoomSeq(12)).toBe(12);
    expect(() => normalizeRoomSeq(0)).toThrow();
    expect(() => normalizeMessageId("x")).toThrow();
    expect(() => normalizeMessageIds([1, "2", 1, 0])).toThrow(); // 0 is invalid
    expect(normalizeMessageIds([3, "4", 3])).toEqual([3, 4]);
    expect(normalizeEmoji("👍")).toBe("👍");
    expect(() => normalizeEmoji("")).toThrow();
    expect(() => normalizeEmoji(1)).toThrow();
  });
});

describe("parseReactions", () => {
  it("parses the documented shape", () => {
    const out = parseReactions({ reactions: { 11: { "👍": [1, 2], "❤️": [2] } } });
    expect(out).toEqual({ 11: { "👍": [1, 2], "❤️": [2] } });
  });

  it("drops malformed entries and empty emoji lists", () => {
    expect(parseReactions({ reactions: { 11: { "👍": [1, 0, "x"] }, 12: { "👍": [] } } })).toEqual({
      11: { "👍": [1] },
    });
    expect(parseReactions(null)).toEqual({});
    expect(parseReactions({})).toEqual({});
  });
});

describe("reactions server client (unverified shape)", () => {
  it("GET lists reactions for the given ids", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ reactions: { 1: { "👍": [7] } } }));
    const c = createReactionsClient({
      baseUrl: "https://bot.ubion.global/", getUserSeq: () => 42, getSessionHeader: async () => "a=b", fetch: fetch as any,
    });
    const r = await c.list(123, [1, 2]);
    expect(r).toEqual({ ok: true, data: { 1: { "👍": [7] } } });
    expect(fetch).toHaveBeenCalledWith(
      "https://bot.ubion.global/v1/reactions?roomSeq=123&ids=1%2C2",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "X-UBM-User-Seq": "42", "X-UBM-Session": "a=b" }),
      }),
    );
  });

  it("POST toggles with the documented body", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ reactions: {} }));
    const c = createReactionsClient({ getUserSeq: () => 42, getSessionHeader: async () => "a=b", fetch: fetch as any });
    const r = await c.toggle(123, 5, "👍");
    expect(r.ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://bot.ubion.global/v1/reactions",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ roomSeq: 123, messageId: 5, emoji: "👍" }) }),
    );
  });

  it("maps 401 to an auth failure and never leaks the session header", async () => {
    const fetch = vi.fn().mockResolvedValue(ok("", 401));
    const c = createReactionsClient({ getUserSeq: () => 1, getSessionHeader: async () => "secret=value", fetch: fetch as any });
    const r = await c.list(1, [1]);
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain("secret=value");
  });

  it("rejects oversized / newline session headers without fetching", async () => {
    const fetch = vi.fn();
    const c = createReactionsClient({ getUserSeq: () => 1, getSessionHeader: async () => "a\r\nb", fetch: fetch as any });
    const r = await c.list(1, [1]);
    expect(r.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails cleanly on network errors", async () => {
    const c = createReactionsClient({ getUserSeq: () => 1, getSessionHeader: async () => "a=b", fetch: vi.fn().mockRejectedValue(new Error("boom")) as any });
    const r = await c.toggle(1, 1, "👍");
    expect(r.ok).toBe(false);
  });
});

describe("reaction self-only guard", () => {
  it("allows the self room only when self-only is on", () => {
    expect(() => guardReactionRoom({ selfOnly: true, roomSeq: 100, me: 5, selfRoomSeq: 100 })).not.toThrow();
    expect(() => guardReactionRoom({ selfOnly: true, roomSeq: 200, me: 5, selfRoomSeq: 100 })).toThrow();
    expect(() => guardReactionRoom({ selfOnly: false, roomSeq: 200, me: 5, selfRoomSeq: 100 })).not.toThrow();
  });
});

describe("reaction chips / optimistic toggle (client)", () => {
  const map = { 1: { "👍": [2, 4], "❤️": [3] } };

  it("builds chips with counts and own-reaction highlight", () => {
    expect(reactionChips(map, 1, 3)).toEqual([
      { emoji: "👍", count: 2, mine: false },
      { emoji: "❤️", count: 1, mine: true },
    ]);
    expect(reactionChips(map, 9, 3)).toEqual([]);
    expect(reactionChips(undefined, 1, 3)).toEqual([]);
  });

  it("toggles my reaction on/off without mutating the input", () => {
    const next = applyToggle(map, 1, "👍", 3);
    expect(map[1]["👍"]).toEqual([2, 4]);
    expect(next[1]["👍"]).toEqual([2, 4, 3]);
    const off = applyToggle(next, 1, "👍", 3);
    expect(off[1]["👍"]).toEqual([2, 4]);
    const removed = applyToggle(map, 1, "❤️", 3);
    expect(removed[1]["❤️"]).toBeUndefined();
  });
});
