import { describe, expect, it, vi } from "vitest";
import {
  createReactionsClient, guardReactionRoom, normalizeEmoji, normalizeMessageId, normalizeMessageIds,
  normalizeRoomSeq, parseReactionToggle, parseReactions, REACTION_EMOJI, REACTION_MAX_EMOJI_LENGTH,
  reactionsCaps, reactionsEnabled,
} from "../electron/core/reactions";
import {
  applyToggle, formatReactionTooltip, mergeReactionUpdate, nextReactionPollDelay, reactionChips,
  reactionPollIds, reactionUiVisibility, REACTION_BACKOFF_MAX_MS, REACTION_BACKOFF_MS, REACTION_POLL_MS,
} from "../src/lib/reactions";

const ok = (body: unknown, status = 200) => ({
  status,
  text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  headers: { get: () => null },
});

describe("reactions caps / normalization", () => {
  it("is on by default and only disabled with UBM_REACTIONS=0", () => {
    expect(reactionsEnabled({ UBM_REACTIONS: "1" })).toBe(true);
    expect(reactionsEnabled({ UBM_REACTIONS: "0" })).toBe(false);
    expect(reactionsEnabled({})).toBe(true);
    expect(reactionsEnabled(undefined)).toBe(true);
    expect(reactionsCaps({})).toEqual({ enabled: true });
    expect(reactionsCaps({ UBM_REACTIONS: "0" })).toEqual({ enabled: false });
  });

  it("ships the 8-emoji quick palette", () => {
    expect(REACTION_EMOJI).toEqual(["👍", "❤️", "😂", "😮", "😢", "🙏", "🎉", "🔥"]);
    expect(REACTION_MAX_EMOJI_LENGTH).toBe(16);
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

  it("accepts any emoji sequence but rejects plain text / ASCII letters and digits", () => {
    expect(normalizeEmoji("🫠")).toBe("🫠");
    expect(normalizeEmoji("👍🏽")).toBe("👍🏽");
    expect(normalizeEmoji("❤️")).toBe("❤️");
    expect(normalizeEmoji("👨‍👩‍👧‍👦")).toBe("👨‍👩‍👧‍👦");
    expect(normalizeEmoji("1️⃣")).toBe("1️⃣");
    expect(() => normalizeEmoji("abc")).toThrow();
    expect(() => normalizeEmoji("1")).toThrow();
    expect(() => normalizeEmoji("a👍")).toThrow();
    expect(() => normalizeEmoji("👍👍👍👍👍👍👍👍👍")).toThrow(); // over the 16 UTF-16-unit cap
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

describe("parseReactionToggle (POST response is one message's emoji map)", () => {
  it("wraps the emoji map with the messageId that was sent", () => {
    expect(parseReactionToggle({
      ok: true, added: true, messageId: 5, reactions: { "👍": [1, 2], "🔥": [2] },
    }, 5)).toEqual({ 5: { "👍": [1, 2], "🔥": [2] } });
  });

  it("keeps an empty entry so a removal can be reconciled", () => {
    expect(parseReactionToggle({ ok: true, added: false, messageId: 5, reactions: {} }, 5)).toEqual({ 5: {} });
    expect(parseReactionToggle(null, 7)).toEqual({ 7: {} });
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

  it("POST toggles with the documented body and returns a ReactionMap keyed by messageId", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ ok: true, added: true, messageId: 5, reactions: { "👍": [42] } }));
    const c = createReactionsClient({ getUserSeq: () => 42, getSessionHeader: async () => "a=b", fetch: fetch as any });
    const r = await c.toggle(123, 5, "👍");
    expect(r).toEqual({ ok: true, data: { 5: { "👍": [42] } } });
    expect(fetch).toHaveBeenCalledWith(
      "https://bot.ubion.global/v1/reactions",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ roomSeq: 123, messageId: 5, emoji: "👍" }) }),
    );
  });

  it("POST removal returns an empty emoji entry for the message", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ ok: true, added: false, messageId: 5, reactions: {} }));
    const c = createReactionsClient({ getUserSeq: () => 42, getSessionHeader: async () => "a=b", fetch: fetch as any });
    expect(await c.toggle(123, 5, "👍")).toEqual({ ok: true, data: { 5: {} } });
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

  it("orders by count, keeping first-seen order for ties", () => {
    const ordered = { 1: { "👍": [1], "❤️": [2, 3], "😂": [4], "🔥": [] } };
    expect(reactionChips(ordered, 1, 99).map((c) => c.emoji)).toEqual(["❤️", "👍", "😂"]);
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

  it("can revert an optimistic toggle to the previous map", () => {
    const optimistic = applyToggle(map, 1, "🎉", 3);
    expect(optimistic[1]["🎉"]).toEqual([3]);
    expect(applyToggle(optimistic, 1, "🎉", 3)).toEqual(map);
  });

  it("reconciles a toggle response into just that message", () => {
    const merged = mergeReactionUpdate({ 1: { "👍": [2] }, 2: { "❤️": [3] } }, { 1: { "🔥": [1] } });
    expect(merged).toEqual({ 1: { "🔥": [1] }, 2: { "❤️": [3] } });
    expect(mergeReactionUpdate({ 1: { "👍": [2] } }, { 1: {} })).toEqual({});
  });
});

describe("reaction tooltip names", () => {
  const names = new Map<number, string>([[1, "김철수"], [2, "이영희"]]);
  const nameFor = (seq: number) => names.get(seq);

  it("lists known names and collapses the overflow into 외 N명", () => {
    expect(formatReactionTooltip("😂", [1, 2, 3, 4, 5], nameFor)).toBe("😂 김철수, 이영희 외 3명");
    expect(formatReactionTooltip("❤️", [1], nameFor)).toBe("❤️ 김철수");
    expect(formatReactionTooltip("🔥", [1, 2], nameFor)).toBe("🔥 김철수, 이영희");
  });

  it("shows 나 for me and counts unknown seqs without inventing names", () => {
    expect(formatReactionTooltip("👍", [9, 1], (seq) => (seq === 9 ? "나" : nameFor(seq)))).toBe("👍 나, 김철수");
    expect(formatReactionTooltip("🎉", [1, 3], nameFor)).toBe("🎉 김철수 외 1명");
    expect(formatReactionTooltip("😮", [7, 8], nameFor)).toBe("😮 2");
  });
});

describe("reaction polling helpers", () => {
  it("polls the newest 100 messages that have a messageId", () => {
    const messages = Array.from({ length: 105 }, (_, i) => ({ messageId: i + 1 }));
    expect(reactionPollIds(messages)).toEqual(Array.from({ length: 100 }, (_, i) => i + 6));
    expect(reactionPollIds([{ messageId: 1 }, { messageId: undefined }, { messageId: 2 }])).toEqual([1, 2]);
    expect(reactionPollIds([{ messageId: 1 }, { messageId: 2 }, { messageId: 1 }])).toEqual([2, 1]);
    expect(reactionPollIds(messages, 0)).toEqual([]);
  });

  it("backs off from 30 s up to 5 min after failures, then returns to 5 s", () => {
    expect(nextReactionPollDelay(0)).toBe(REACTION_POLL_MS);
    expect(nextReactionPollDelay(-1)).toBe(REACTION_POLL_MS);
    expect(nextReactionPollDelay(1)).toBe(REACTION_BACKOFF_MS);
    expect(nextReactionPollDelay(2)).toBe(60_000);
    expect(nextReactionPollDelay(3)).toBe(120_000);
    expect(nextReactionPollDelay(4)).toBe(240_000);
    expect(nextReactionPollDelay(5)).toBe(REACTION_BACKOFF_MAX_MS);
    expect(nextReactionPollDelay(99)).toBe(REACTION_BACKOFF_MAX_MS);
  });

  it("hides the UI on disabled caps or a failed list, and keeps retrying on failure", () => {
    expect(reactionUiVisibility(true, false)).toEqual({ show: true, retry: false });
    expect(reactionUiVisibility(true, true)).toEqual({ show: false, retry: true });
    expect(reactionUiVisibility(false, false)).toEqual({ show: false, retry: false });
    expect(reactionUiVisibility(false, true)).toEqual({ show: false, retry: false });
  });
});
