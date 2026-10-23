import { describe, expect, it } from "vitest";
import {
  AUTH_MARKER_RE, composeEditText, composeQuoteText, decodeEditId, decodeReplyId, EDIT_TAG, encodeEditMarker,
  encodeReplyMarker, isAuthMarkerText, isBotAuthDm, parseMessage, stripEditMarkers, stripReplyMarkers, truncateQuote,
} from "../src/lib/markers";

const AUTH_TEXT = "인증 코드: [[ubm:auth:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBB]]";

describe("markers: auth DM hiding", () => {
  it("requires a complete marker, not just the prefix", () => {
    expect(isAuthMarkerText(AUTH_TEXT)).toBe(true);
    expect(AUTH_MARKER_RE.test(AUTH_TEXT)).toBe(true);
    expect(isAuthMarkerText("인증 코드: [[ubm:auth:incomplete")).toBe(false);
    expect(isAuthMarkerText("[[ubm:auth:AAAAAAAAAAAAAAAA:short]]")).toBe(false);
    expect(isAuthMarkerText("no marker")).toBe(false);
  });

  it("hides only a complete marker from the known bot in a buddy room", () => {
    expect(isBotAuthDm({
      text: AUTH_TEXT, roomKind: "buddy", senderSeq: 99, botUserSeq: 99,
    })).toBe(true);
    expect(isBotAuthDm({
      text: AUTH_TEXT, roomKind: "buddy", senderSeq: "99", botUserSeq: 99,
    })).toBe(true);
  });

  it("never hides when the room, sender, marker, or bot identity is unknown", () => {
    expect(isBotAuthDm({
      text: AUTH_TEXT, roomKind: "room", senderSeq: 99, botUserSeq: 99,
    })).toBe(false);
    expect(isBotAuthDm({
      text: AUTH_TEXT, roomKind: "buddy", senderSeq: 7, botUserSeq: 99,
    })).toBe(false);
    expect(isBotAuthDm({
      text: "인증 코드: [[ubm:auth:incomplete", roomKind: "buddy", senderSeq: 99, botUserSeq: 99,
    })).toBe(false);
    expect(isBotAuthDm({
      text: AUTH_TEXT, roomKind: "buddy", senderSeq: 99, botUserSeq: 0,
    })).toBe(false);
    expect(isBotAuthDm({
      text: AUTH_TEXT, roomKind: "buddy", senderSeq: 99, botUserSeq: undefined,
    })).toBe(false);
  });
});

describe("markers: edit encode/decode", () => {
  it("round-trips a positive id", () => {
    expect(encodeEditMarker(123)).toBe("[[ubm:edit:123]]");
    expect(decodeEditId("안녕\n(수정됨)[[ubm:edit:123]]")).toBe(123);
  });

  it("returns null for missing/invalid ids", () => {
    expect(decodeEditId("plain text")).toBeNull();
    expect(decodeEditId("[[ubm:edit:0]]")).toBeNull();
    expect(decodeEditId("[[ubm:edit:-3]]")).toBeNull();
    expect(decodeEditId("[[ubm:edit:1.5]]")).toBeNull();
    expect(decodeEditId(undefined)).toBeNull();
  });

  it("strips edit markers only", () => {
    expect(stripEditMarkers("본문[[ubm:edit:9]]")).toBe("본문");
    expect(stripEditMarkers("본문")).toBe("본문");
    expect(stripEditMarkers(null)).toBe("");
  });
});

describe("markers: reply encode/decode", () => {
  it("round-trips a positive id", () => {
    expect(encodeReplyMarker(7)).toBe("[[re:7]]");
    expect(decodeReplyId("> 김하늘: 안녕\n네[[re:7]]")).toBe(7);
  });

  it("does not confuse edit markers with reply markers", () => {
    expect(decodeReplyId("[[ubm:edit:12]]")).toBeNull();
    expect(decodeEditId("[[re:12]]")).toBeNull();
  });

  it("strips reply markers only", () => {
    expect(stripReplyMarkers("네[[re:7]]")).toBe("네");
  });
});

describe("markers: compose / parse (edit)", () => {
  it("composes the readable-edit format and parses it back", () => {
    const raw = composeEditText("수정된 본문", 42);
    expect(raw).toBe("수정된 본문\n(수정됨)[[ubm:edit:42]]");
    const p = parseMessage(raw);
    expect(p.editedId).toBe(42);
    expect(p.body).toBe("수정된 본문");
    expect(p.replyId).toBeNull();
    expect(p.quote).toBeUndefined();
  });

  it("leaves ordinary messages untouched", () => {
    const p = parseMessage("그냥 메시지");
    expect(p).toEqual({ body: "그냥 메시지", editedId: null, replyId: null });
  });
});

describe("markers: compose / parse (quote reply)", () => {
  it("composes a truncated quote + marker and parses it back", () => {
    const raw = composeQuoteText("김하늘", "아주 긴 원문", "네, 확인했어요", 5);
    expect(raw.startsWith("> 김하늘: 아주 긴 원문\n")).toBe(true);
    expect(raw.endsWith("네, 확인했어요[[re:5]]")).toBe(true);
    const p = parseMessage(raw);
    expect(p.replyId).toBe(5);
    expect(p.quote).toEqual({ senderName: "김하늘", text: "아주 긴 원문" });
    expect(p.body).toBe("네, 확인했어요");
    expect(p.editedId).toBeNull();
  });

  it("truncates long originals to one line with an ellipsis", () => {
    const q = truncateQuote("가".repeat(200));
    expect(q.length).toBe(80);
    expect(q.endsWith("…")).toBe(true);
    expect(truncateQuote("짧은\n  원문", 20)).toBe("짧은 원문");
  });
});

describe("markers: parse does not fake a quote without a reply marker", () => {
  it("keeps a leading > line when there is no reply marker", () => {
    const p = parseMessage("> 그냥 인용처럼 보이는 글\n본문");
    expect(p.quote).toBeUndefined();
    expect(p.body).toBe("> 그냥 인용처럼 보이는 글\n본문");
  });
});
