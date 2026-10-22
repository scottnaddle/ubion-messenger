import { describe, expect, it } from "vitest";
import { normalizeKoreanDate, formatKst, toKstParts } from "../electron/core/todo/dates-ko";
import { extractFromMessage, titleSimilarity, normalizeTitle } from "../electron/core/todo/extract";
import { parseZoom, buildZoomJoin, maskPasscode } from "../electron/core/todo/zoom";
import { todosToIcs } from "../electron/core/todo/ics";
import { planReminders, inWorkHours, bossCopy } from "../electron/core/todo/reminders";
import type { TodoItem, TodoSettings } from "../electron/core/todo/types";

const ANCHOR = "2026-10-23T09:00:00+09:00"; // Friday

describe("dates-ko", () => {
  it("금일 / 오늘", () => {
    const r = normalizeKoreanDate("금일 회의 있습니다", ANCHOR)!;
    expect(r.iso.startsWith("2026-10-23")).toBe(true);
    expect(r.confidence).toBeGreaterThan(0.9);
  });
  it("내일 + 오후 3시", () => {
    const r = normalizeKoreanDate("내일 오후 3시까지 제출 부탁드려요", ANCHOR)!;
    expect(r.iso).toBe("2026-10-24T15:00:00+09:00");
    expect(r.role).toBe("due");
  });
  it("모레 / 글피", () => {
    expect(normalizeKoreanDate("모레까지", ANCHOR)!.iso.startsWith("2026-10-25")).toBe(true);
    expect(normalizeKoreanDate("글피", ANCHOR)!.iso.startsWith("2026-10-26")).toBe(true);
  });
  it("이번 주 금요일", () => {
    // anchor is already Friday
    const r = normalizeKoreanDate("이번 주 금요일 보고", ANCHOR)!;
    expect(r.iso.startsWith("2026-10-23")).toBe(true);
  });
  it("다음 주 월요일", () => {
    const r = normalizeKoreanDate("다음 주 월요일까지", ANCHOR)!;
    expect(r.iso.startsWith("2026-10-26") || r.iso.startsWith("2026-10-27")).toBe(true);
  });
  it("10/24 and 10월 24일", () => {
    expect(normalizeKoreanDate("10/24까지", ANCHOR)!.iso.startsWith("2026-10-24")).toBe(true);
    expect(normalizeKoreanDate("10월 24일 오전 10시", ANCHOR)!.iso).toBe("2026-10-24T10:00:00+09:00");
  });
  it("EOD / 오늘 중 → 18:00", () => {
    const r = normalizeKoreanDate("오늘 중 회신 주세요", ANCHOR)!;
    expect(r.iso.endsWith("T18:00:00+09:00") || r.iso.includes("T18:00")).toBe(true);
  });
  it("3시 반 heuristic afternoon", () => {
    const r = normalizeKoreanDate("3시 반 미팅", ANCHOR)!;
    expect(r.iso).toContain("T15:30:00+09:00");
  });
  it("15:30", () => {
    expect(normalizeKoreanDate("15:30 회의", ANCHOR)!.iso).toContain("T15:30:00+09:00");
  });
  it("월말", () => {
    const r = normalizeKoreanDate("이번 달 말까지", ANCHOR)!;
    expect(r.iso.startsWith("2026-10-31")).toBe(true);
  });
  it("formatKst / toKstParts", () => {
    expect(formatKst(2026, 10, 23, 9, 0, 0)).toBe("2026-10-23T09:00:00+09:00");
    const p = toKstParts(ANCHOR);
    expect(p.y).toBe(2026);
    expect(p.d).toBe(23);
    expect(p.dow).toBe(5);
  });
});

describe("zoom parser", () => {
  it("parses zoom.us/j with pwd", () => {
    const z = parseZoom("회의 링크 https://ubion.zoom.us/j/12345678901?pwd=SecretAbc 부탁해요", ANCHOR)!;
    expect(z.meetingId).toBe("12345678901");
    expect(z.passcode).toBe("SecretAbc");
    expect(z.joinUrl).not.toContain("SecretAbc");
    expect(z.confidence).toBeGreaterThan(0.9);
  });
  it("parses vanity /my/", () => {
    const z = parseZoom("https://zoom.us/my/scott.room 들어오세요", ANCHOR)!;
    expect(z.joinUrl).toContain("/my/scott.room");
  });
  it("parses zoommtg deep link", () => {
    const z = parseZoom("zoommtg://zoom.us/join?confno=98765432101&pwd=xxYY", ANCHOR)!;
    expect(z.meetingId).toBe("98765432101");
    expect(z.passcode).toBe("xxYY");
  });
  it("parses KO meeting id + passcode", () => {
    const text = `Zoom 초대
주제: 주간 싱크
시간: 2026년 10월 24일 오후 03:00 서울
회의 ID: 123 4567 8901
암호: 424242`;
    const z = parseZoom(text, ANCHOR)!;
    expect(z.meetingId).toBe("12345678901");
    expect(z.passcode).toBe("424242");
    expect(z.startIso).toContain("2026-10-24T15:00");
  });
  it("parses EN invite", () => {
    const text = `Topic: Sync
Time: Oct 24, 2026 03:00 PM Seoul
Meeting ID: 111 2222 3333
Passcode: hello1
https://zoom.us/j/11122223333`;
    const z = parseZoom(text, ANCHOR)!;
    expect(z.meetingId).toBe("11122223333");
    expect(z.passcode).toBe("hello1");
  });
  it("buildZoomJoin prefers deep link", () => {
    const j = buildZoomJoin({ meetingId: "12345678901", passcode: "ab" });
    expect(j.primary.startsWith("zoommtg://")).toBe(true);
    expect(j.fallback).toContain("12345678901");
    expect(j.fallback).toContain("pwd=");
  });
  it("maskPasscode", () => {
    expect(maskPasscode("secret")).toMatch(/^•+$/);
    expect(maskPasscode("secret")).not.toContain("s");
  });
});

describe("extract", () => {
  it("request with deadline → high score", () => {
    const r = extractFromMessage({
      text: "보고서 내일 오후 3시까지 제출 부탁드려요",
      createdAt: ANCHOR,
      isMine: false,
      roomKind: "buddy",
      senderName: "김대리",
      mySeq: 1,
    })!;
    expect(r.score).toBeGreaterThanOrEqual(0.85);
    expect(r.due?.iso).toBe("2026-10-24T15:00:00+09:00");
    expect(r.isRequest).toBe(true);
  });
  it("self promise", () => {
    const r = extractFromMessage({
      text: "오늘 중으로 확인하겠습니다",
      createdAt: ANCHOR,
      isMine: true,
      roomKind: "buddy",
      senderName: "나",
      mySeq: 1,
    })!;
    expect(r.isSelfPromise).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0.5);
  });
  it("accept reply confirms prior request", () => {
    const r = extractFromMessage({
      text: "네 알겠습니다",
      createdAt: ANCHOR,
      isMine: true,
      roomKind: "buddy",
      senderName: "나",
      mySeq: 1,
      prior: [
        { text: "내일까지 자료 공유 바랍니다", isMine: false, senderName: "박팀장", createdAt: ANCHOR },
      ],
    })!;
    expect(r.isAcceptReply).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0.85);
    expect(r.title).toContain("자료");
  });
  it("completion", () => {
    const r = extractFromMessage({
      text: "요청하신 건 완료했습니다",
      createdAt: ANCHOR,
      isMine: true,
      roomKind: "buddy",
      senderName: "나",
    })!;
    expect(r.isCompletion).toBe(true);
  });
  it("ignores greeting", () => {
    expect(
      extractFromMessage({
        text: "안녕하세요",
        createdAt: ANCHOR,
        isMine: false,
        roomKind: "buddy",
        senderName: "A",
      }),
    ).toBeNull();
  });
  it("zoom message → meeting", () => {
    const r = extractFromMessage({
      text: "금일 10시 회의입니다 https://zoom.us/j/12345678901?pwd=abc",
      createdAt: ANCHOR,
      isMine: false,
      roomKind: "room",
      senderName: "사회자",
    })!;
    expect(r.type).toBe("meeting");
    expect(r.zoom?.meetingId).toBe("12345678901");
    expect(r.score).toBeGreaterThanOrEqual(0.85);
  });
  it("titleSimilarity / normalizeTitle", () => {
    expect(titleSimilarity("보고서 제출", "보고서제출 부탁")).toBeGreaterThan(0.5);
    expect(normalizeTitle("Hello!!")).toBe("hello");
  });
});

describe("ics + reminders", () => {
  const settings: TodoSettings = {
    enabledRooms: [],
    remindersEnabled: true,
    workStartHour: 9,
    workEndHour: 19,
    quietDuringMeetings: true,
    zoomNotifyMinutes: [10, 1],
    llmFallback: false,
    politeMode: false,
  };
  it("todosToIcs", () => {
    const ics = todosToIcs([
      {
        id: "t1",
        title: "회의",
        type: "meeting",
        status: "open",
        start: "2026-10-24T15:00:00+09:00",
        confidence: 1,
        origin: "manual",
        createdAt: ANCHOR,
        updatedAt: ANCHOR,
        zoomJoinUrl: "https://zoom.us/j/1",
      },
    ]);
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("SUMMARY:회의");
  });
  it("planReminders zoom 10m", () => {
    const start = new Date(Date.now() + 10 * 60000).toISOString();
    const items: TodoItem[] = [
      {
        id: "z1",
        title: "Zoom sync",
        type: "meeting",
        status: "open",
        start,
        confidence: 1,
        origin: "auto",
        createdAt: ANCHOR,
        updatedAt: ANCHOR,
      },
    ];
    const actions = planReminders(items, settings, new Date());
    expect(actions.some((a) => a.kind === "zoom" && a.minutesBefore === 10)).toBe(true);
  });
  it("bossCopy tones", () => {
    expect(bossCopy(1, "A", false).title).toContain("마감");
    expect(bossCopy(3, "A", true).title).toContain("미완료");
  });
  it("inWorkHours", () => {
    // 2026-10-23 10:00 KST = 2026-10-23T01:00:00Z
    expect(inWorkHours(new Date("2026-10-23T01:00:00Z"), settings)).toBe(true);
    // 22:00 KST
    expect(inWorkHours(new Date("2026-10-23T13:00:00Z"), settings)).toBe(false);
  });
});
