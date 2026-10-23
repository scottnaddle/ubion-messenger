import { describe, expect, it, vi } from "vitest";
import {
  createPollsClient, guardPollRoom, normalizeOptionIndex, normalizePollId, normalizePollInput,
  parsePoll, pollsCaps, pollsEnabled,
} from "../electron/core/polls";
import { applyPollVote, pollMyVotes, pollTotals } from "../src/lib/polls";
import { decodePollId, encodePollMarker, parseMessage, stripPollMarkers } from "../src/lib/markers";

const ok = (body: unknown, status = 200) => ({
  status,
  text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  headers: { get: () => null },
});

const pollBody = {
  id: 7,
  roomSeq: 123,
  question: "점심 뭐 먹지?",
  options: ["한식", "중식", "양식"],
  multiSelect: false,
  closed: false,
  votes: { 0: [1, 2], 1: [3] },
};

describe("polls caps / normalization", () => {
  it("is enabled only with UBM_POLLS=1", () => {
    expect(pollsEnabled({ UBM_POLLS: "1" })).toBe(true);
    expect(pollsEnabled({})).toBe(false);
    expect(pollsEnabled(undefined)).toBe(false);
    expect(pollsCaps({ UBM_POLLS: "1", UBM_SELF_ONLY: "1" })).toEqual({ enabled: true, selfOnly: true });
  });

  it("validates poll input", () => {
    const input = normalizePollInput({ roomSeq: 123, question: "q", options: ["a", "b"], multiSelect: false });
    expect(input).toEqual({ roomSeq: 123, question: "q", options: ["a", "b"], multiSelect: false, deadline: undefined });
    expect(() => normalizePollInput({ roomSeq: 0, question: "q", options: ["a", "b"] })).toThrow();
    expect(() => normalizePollInput({ roomSeq: 1, question: "", options: ["a", "b"] })).toThrow();
    expect(() => normalizePollInput({ roomSeq: 1, question: "q", options: ["a"] })).toThrow();
    expect(normalizePollInput({ roomSeq: 1, question: "q", options: ["a", "b"], multiSelect: true, deadline: 1234 })).toMatchObject({ deadline: 1234 });
  });

  it("validates poll id / option index", () => {
    expect(normalizePollId(7)).toBe(7);
    expect(() => normalizePollId(0)).toThrow();
    expect(() => normalizePollId("x")).toThrow();
    expect(normalizeOptionIndex(0)).toBe(0);
    expect(() => normalizeOptionIndex(-1)).toThrow();
  });
});

describe("parsePoll", () => {
  it("parses the documented shape", () => {
    expect(parsePoll(pollBody)).toEqual({
      id: 7, roomSeq: 123, question: "점심 뭐 먹지?", options: ["한식", "중식", "양식"],
      multiSelect: false, closed: false, deadline: undefined, votes: { 0: [1, 2], 1: [3] },
    });
  });

  it("drops malformed bodies and votes", () => {
    expect(parsePoll(null)).toBeNull();
    expect(parsePoll({})).toBeNull();
    expect(parsePoll({ id: 0 })).toBeNull();
    expect(parsePoll({ id: 1, votes: { 0: [0, "x"] } })).toMatchObject({ id: 1, votes: {} });
  });
});

describe("polls server client (unverified shape)", () => {
  it("POST create sends the documented body", async () => {
    const fetch = vi.fn().mockResolvedValue(ok(pollBody));
    const c = createPollsClient({ getUserSeq: () => 42, getSessionHeader: async () => "a=b", fetch: fetch as any });
    const r = await c.create({ roomSeq: 123, question: "q", options: ["a", "b"], multiSelect: false, deadline: 99 });
    expect(r).toEqual({ ok: true, data: parsePoll(pollBody) });
    expect(fetch).toHaveBeenCalledWith(
      "https://bot.ubion.global/v1/polls",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-UBM-User-Seq": "42", "X-UBM-Session": "a=b" }),
        body: JSON.stringify({ roomSeq: 123, question: "q", options: ["a", "b"], multiSelect: false, deadline: 99 }),
      }),
    );
  });

  it("GET / vote / close hit the documented paths", async () => {
    const fetch = vi.fn().mockResolvedValue(ok(pollBody));
    const c = createPollsClient({ getUserSeq: () => 1, getSessionHeader: async () => "a=b", fetch: fetch as any });
    await c.get(7);
    await c.vote(7, 1);
    await c.close(7);
    expect(fetch).toHaveBeenNthCalledWith(1, "https://bot.ubion.global/v1/polls/7", expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(2, "https://bot.ubion.global/v1/polls/7/vote", expect.objectContaining({ body: JSON.stringify({ optionIndex: 1 }) }));
    expect(fetch).toHaveBeenNthCalledWith(3, "https://bot.ubion.global/v1/polls/7/close", expect.any(Object));
  });

  it("maps 401 to an auth failure and never leaks the session header", async () => {
    const fetch = vi.fn().mockResolvedValue(ok("", 401));
    const c = createPollsClient({ getUserSeq: () => 1, getSessionHeader: async () => "secret=value", fetch: fetch as any });
    const r = await c.get(1);
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain("secret=value");
  });

  it("rejects oversized / newline session headers without fetching", async () => {
    const fetch = vi.fn();
    const c = createPollsClient({ getUserSeq: () => 1, getSessionHeader: async () => "a\r\nb", fetch: fetch as any });
    const r = await c.get(1);
    expect(r.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails cleanly on network errors", async () => {
    const c = createPollsClient({ getUserSeq: () => 1, getSessionHeader: async () => "a=b", fetch: vi.fn().mockRejectedValue(new Error("boom")) as any });
    expect((await c.get(1)).ok).toBe(false);
  });
});

describe("poll self-only guard", () => {
  it("allows the self room only when self-only is on", () => {
    expect(() => guardPollRoom({ selfOnly: true, roomSeq: 100, me: 5, selfRoomSeq: 100 })).not.toThrow();
    expect(() => guardPollRoom({ selfOnly: true, roomSeq: 200, me: 5, selfRoomSeq: 100 })).toThrow();
    expect(() => guardPollRoom({ selfOnly: false, roomSeq: 200, me: 5, selfRoomSeq: 100 })).not.toThrow();
  });
});

describe("poll client helpers", () => {
  const poll = {
    id: 1, roomSeq: 1, question: "q", options: ["a", "b", "c"],
    multiSelect: false, closed: false, votes: { 0: [1, 2], 1: [3] },
  };

  it("computes totals and my votes", () => {
    expect(pollTotals(poll)).toEqual([2, 1, 0]);
    expect(pollMyVotes(poll, 3)).toEqual([1]);
    expect(pollMyVotes(poll, 9)).toEqual([]);
  });

  it("single-select vote moves my vote", () => {
    const next = applyPollVote(poll, 2, 3);
    expect(next.votes).toEqual({ 0: [1, 2], 2: [3] });
    expect(poll.votes).toEqual({ 0: [1, 2], 1: [3] });
  });

  it("multi-select vote toggles my vote", () => {
    const multi = { ...poll, multiSelect: true };
    const on = applyPollVote(multi, 0, 3);
    expect(on.votes[0]).toEqual([1, 2, 3]);
    const off = applyPollVote(on, 0, 3);
    expect(off.votes[0]).toEqual([1, 2]);
  });
});

describe("poll markers", () => {
  it("encodes/decodes/strips the poll marker", () => {
    expect(encodePollMarker(9)).toBe("[[ubm:poll:9]]");
    expect(decodePollId("점심 투표\n[[ubm:poll:9]]")).toBe(9);
    expect(decodePollId("no marker")).toBeNull();
    expect(stripPollMarkers("점심 투표\n[[ubm:poll:9]]")).toBe("점심 투표\n");
  });

  it("parseMessage hides the poll marker from the plain text", () => {
    expect(decodePollId("점심 뭐 먹지?\n[[ubm:poll:12]]")).toBe(12);
    expect(parseMessage("점심 뭐 먹지?\n[[ubm:poll:12]]")).toEqual({
      body: "점심 뭐 먹지?\n", editedId: null, replyId: null, quote: undefined,
    });
  });
});
