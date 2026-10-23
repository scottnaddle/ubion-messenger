import { describe, expect, it } from "vitest";
import {
  filterMembers, findMentionTrigger, insertMention, isMentioningMe, parseMentionTokens,
} from "../src/lib/mention";

const members = [
  { userId: 1, name: "김하늘", position: "책임", department: "개발팀" },
  { userId: 2, name: "김 하늘", position: "디자이너", department: "디자인팀" },
  { userId: 3, name: "이서준", position: "선임", department: "개발팀" },
  { userId: 4, name: "유비온봇", position: "챗봇", department: "UBION" },
  { userId: 5, name: "Kim Minsoo", position: "Manager", department: "Global" },
];

describe("findMentionTrigger", () => {
  it("triggers at the start of the text", () => {
    expect(findMentionTrigger("@김하늘", 4)).toEqual({ start: 0, query: "김하늘" });
    expect(findMentionTrigger("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("triggers after whitespace and keeps the query up to the cursor", () => {
    const text = "안녕 @김하늘";
    expect(findMentionTrigger(text, text.length)).toEqual({ start: 3, query: "김하늘" });
    expect(findMentionTrigger(text, 5)).toEqual({ start: 3, query: "김" });
  });

  it("does not trigger inside an email address", () => {
    expect(findMentionTrigger("a@b.com", 3)).toBeNull();
    expect(findMentionTrigger("mail a@b.com", 8)).toBeNull();
    expect(findMentionTrigger("메일 a@b.com", "메일 a@b.com".length)).toBeNull();
  });

  it("does not trigger when the query contains whitespace/newline", () => {
    expect(findMentionTrigger("@김 하늘", "@김 하늘".length)).toBeNull();
    expect(findMentionTrigger("안녕 @김\n하늘", "안녕 @김\n하늘".length)).toBeNull();
  });

  it("returns null when the cursor is not on an @ token", () => {
    expect(findMentionTrigger("안녕하세요", 5)).toBeNull();
    expect(findMentionTrigger("", 0)).toBeNull();
    expect(findMentionTrigger("@김하늘 ", "@김하늘 ".length)).toBeNull();
    expect(findMentionTrigger("안녕 @김하늘", 3)).toBeNull();
    expect(findMentionTrigger("@김하늘", 0)).toBeNull();
  });
});

describe("filterMembers", () => {
  it("excludes me and matches Korean names case-insensitively", () => {
    expect(filterMembers(members, "김", 1).map((m) => m.userId)).toEqual([2]);
    expect(filterMembers(members, "kim", 1).map((m) => m.userId)).toEqual([5]);
  });

  it("ranks name startsWith > name includes > other fields, stably", () => {
    const list = [
      { userId: 10, name: "이김", position: "", department: "" },
      { userId: 11, name: "김철수", position: "", department: "" },
      { userId: 12, name: "박영희", position: "김팀장", department: "" },
      { userId: 13, name: "김영수", position: "", department: "" },
    ];
    expect(filterMembers(list, "김", 99).map((m) => m.userId)).toEqual([11, 13, 10, 12]);
  });

  it("matches position and department and limits to 8", () => {
    expect(filterMembers(members, "챗봇", 1).map((m) => m.userId)).toEqual([4]);
    expect(filterMembers(members, "디자인", 1).map((m) => m.userId)).toEqual([2]);

    const many = Array.from({ length: 12 }, (_, i) => ({ userId: i + 20, name: `멤버${i}` }));
    expect(filterMembers(many, "멤버", 99)).toHaveLength(8);
  });

  it("returns everyone except me for an empty query", () => {
    expect(filterMembers(members, "", 1).map((m) => m.userId)).toEqual([2, 3, 4, 5]);
  });
});

describe("insertMention", () => {
  it("replaces @query with @name and a trailing space, returning the caret", () => {
    const text = "안녕 @김";
    const trigger = findMentionTrigger(text, text.length)!;
    expect(insertMention(text, trigger, text.length, "김하늘")).toEqual({
      text: "안녕 @김하늘 ", cursor: "안녕 @김하늘 ".length,
    });
  });

  it("supports names with spaces", () => {
    const text = "@김";
    const trigger = findMentionTrigger(text, text.length)!;
    expect(insertMention(text, trigger, text.length, "김 하늘")).toEqual({
      text: "@김 하늘 ", cursor: 6,
    });
  });
});

describe("parseMentionTokens", () => {
  const names = ["김", "김하늘", "김 하늘", "유비온봇"];

  it("parses Korean names and names with spaces (longest first)", () => {
    const text = "안녕 @김하늘, @김 하늘 그리고 @유비온봇";
    expect(parseMentionTokens(text, names).filter((s) => s.type === "mention")).toEqual([
      { type: "mention", value: "@김하늘", name: "김하늘" },
      { type: "mention", value: "@김 하늘", name: "김 하늘" },
      { type: "mention", value: "@유비온봇", name: "유비온봇" },
    ]);
  });

  it("keeps the original text split into segments", () => {
    const text = "(@김하늘) 안녕 @김 하늘!";
    expect(parseMentionTokens(text, names).map((s) => s.value).join("")).toBe(text);
  });

  it("requires a boundary before @ and a non-word character after the name", () => {
    const text = "a@김하늘 @김하늘님 @유비온봇! @없는사람";
    const mentions = parseMentionTokens(text, names).filter((s) => s.type === "mention");
    expect(mentions).toEqual([{ type: "mention", value: "@유비온봇", name: "유비온봇" }]);
  });

  it("returns no mention tokens for an email address", () => {
    const tokens = parseMentionTokens("a@b.com", ["b"]);
    expect(tokens).toEqual([{ type: "text", value: "a@b.com" }]);
  });
});

describe("isMentioningMe", () => {
  it("matches my full Korean name including spaces", () => {
    expect(isMentioningMe("안녕 @김 하늘", "김 하늘")).toBe(true);
    expect(isMentioningMe("@김하늘 확인 부탁드려요", "김하늘")).toBe(true);
    expect(isMentioningMe("(@유비온봇)", "유비온봇")).toBe(true);
  });

  it("respects boundaries and full-name matching", () => {
    expect(isMentioningMe("@김하늘님", "김하늘")).toBe(false);
    expect(isMentioningMe("a@김하늘", "김하늘")).toBe(false);
    expect(isMentioningMe("@김하늘", "김")).toBe(false);
    expect(isMentioningMe("안녕하세요", "김하늘")).toBe(false);
    expect(isMentioningMe("@김하늘", "")).toBe(false);
  });
});
