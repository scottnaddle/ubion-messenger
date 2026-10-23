import { describe, expect, it } from "vitest";
import {
  DAOU_STICKERS_ENABLED, EMOJI_CATEGORIES, RECENT_EMOJI_KEY, RECENT_EMOJI_MAX, emoticonImagePath, insertAtSelection,
  loadRecentEmoji, parseEmoticonCodes, parseRecentEmoji, pickerCategories, pushRecentEmoji, saveRecentEmoji,
} from "../src/lib/emoticon";

function memStorage(init: Record<string, string> = {}) {
  const data = { ...init };
  return { data, getItem: (k: string) => (k in data ? data[k] : null), setItem: (k: string, v: string) => { data[k] = v; } };
}

describe("emoji set", () => {
  it("has ~120 unique emoji across categories", () => {
    const all = EMOJI_CATEGORIES.flatMap((c) => c.emoji);
    expect(all.length).toBeGreaterThanOrEqual(100);
    expect(new Set(all).size).toBe(all.length);
    expect(EMOJI_CATEGORIES.map((c) => c.label)).toEqual(["표정", "손", "하트", "사물"]);
  });

  it("adds 자주 사용 tab only when there are recents", () => {
    expect(pickerCategories([])[0].id).toBe("face");
    const cats = pickerCategories(["👍"]);
    expect(cats[0]).toEqual({ id: "recent", label: "자주 사용", emoji: ["👍"] });
    expect(cats).toHaveLength(EMOJI_CATEGORIES.length + 1);
  });
});

describe("recent emoji", () => {
  it("moves to front, dedupes, caps", () => {
    expect(pushRecentEmoji(["😀", "👍", "❤️"], "👍")).toEqual(["👍", "😀", "❤️"]);
    expect(pushRecentEmoji([], "🎉")).toEqual(["🎉"]);
    expect(pushRecentEmoji(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
    expect(pushRecentEmoji(["a"], "")).toEqual(["a"]);
  });

  it("parses stored list defensively", () => {
    expect(parseRecentEmoji(null)).toEqual([]);
    expect(parseRecentEmoji("not json")).toEqual([]);
    expect(parseRecentEmoji('{"a":1}')).toEqual([]);
    expect(parseRecentEmoji('["😀", 3, "", "😀", "👍", "' + "x".repeat(40) + '"]')).toEqual(["😀", "👍"]);
    const many = JSON.stringify(Array.from({ length: 50 }, (_, i) => `e${i}`));
    expect(parseRecentEmoji(many)).toHaveLength(RECENT_EMOJI_MAX);
  });

  it("round-trips through storage and survives a throwing storage", () => {
    const s = memStorage();
    saveRecentEmoji(["👍", "😀"], s);
    expect(JSON.parse(s.data[RECENT_EMOJI_KEY])).toEqual(["👍", "😀"]);
    expect(loadRecentEmoji(s)).toEqual(["👍", "😀"]);
    const bad = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
    expect(loadRecentEmoji(bad)).toEqual([]);
    expect(() => saveRecentEmoji(["👍"], bad)).not.toThrow();
    expect(loadRecentEmoji(undefined)).toEqual([]);
  });
});

describe("insertAtSelection", () => {
  it("inserts at caret / replaces selection / clamps", () => {
    expect(insertAtSelection("ab", 1, 1, "😀")).toEqual({ text: "a😀b", cursor: 3 });
    expect(insertAtSelection("hello", 1, 4, "👍")).toEqual({ text: "h👍o", cursor: 3 });
    expect(insertAtSelection("ab", 99, 99, "!")).toEqual({ text: "ab!", cursor: 3 });
    expect(insertAtSelection("ab", -5, 1, "!")).toEqual({ text: "!b", cursor: 1 });
  });
});

describe("DaouOffice sticker codes", () => {
  const known = new Set(["smile", "thumbs_up"]);

  it("is off by default", () => {
    expect(DAOU_STICKERS_ENABLED).toBe(false);
    expect(parseEmoticonCodes("hi (smile)")).toEqual([{ type: "text", value: "hi (smile)" }]);
    expect(parseEmoticonCodes("hi (smile)", known, false)).toEqual([{ type: "text", value: "hi (smile)" }]);
    expect(parseEmoticonCodes("hi (smile)", new Set(), true)).toEqual([{ type: "text", value: "hi (smile)" }]);
    expect(parseEmoticonCodes("", known, true)).toEqual([]);
  });

  it("splits known codes into stickers, leaves unknown codes as text", () => {
    expect(parseEmoticonCodes("hi (smile)(nope) ok (thumbs_up)", known, true)).toEqual([
      { type: "text", value: "hi " },
      { type: "sticker", name: "smile", src: "resources/images/emoticon/smile.png", value: "(smile)" },
      { type: "text", value: "(nope) ok " },
      { type: "sticker", name: "thumbs_up", src: "resources/images/emoticon/thumbs_up.png", value: "(thumbs_up)" },
    ]);
    expect(parseEmoticonCodes("(smile)", known, true)).toEqual([
      { type: "sticker", name: "smile", src: emoticonImagePath("smile"), value: "(smile)" },
    ]);
  });

  it("never matches path-like names", () => {
    const k = new Set(["../x", "a/b"]);
    expect(parseEmoticonCodes("(../x) (a/b)", k, true)).toEqual([{ type: "text", value: "(../x) (a/b)" }]);
  });
});
