import { describe, expect, it, vi } from "vitest";
import {
  ROOM_AI_ROOM_LIMIT, loadRoomAi, mergeRoomAiTodos, roomAiFingerprint, roomAiShouldRun, roomAiTodoId,
  saveRoomAi, stubExtractTodos, stubSummarize, toggleRoomAiTodo, toRoomAiMessages,
  RoomAiService, type RoomAiMessage, type StorageLike,
} from "../src/lib/room-ai";

function memory(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
  };
}

const sample: RoomAiMessage[] = [
  { id: 1, sender: "김민수", text: "자료 검토 부탁합니다", createdAt: "2026-10-24T09:00:00+09:00" },
  { id: 2, sender: "이서연", text: "내일까지 회신해주세요", createdAt: "2026-10-24T09:05:00+09:00" },
];

describe("room AI stub provider", () => {
  it("synthesizes the whole window instead of quoting messages", () => {
    const summary = stubSummarize(sample);
    expect(summary).toBe(stubSummarize(sample));
    expect(stubExtractTodos(sample)).toEqual(stubExtractTodos(sample));
    expect(summary.startsWith("[스텁] 메시지 2건")).toBe(true);
    expect(summary).toContain("10/24 09:00–10/24 09:05");
    expect(summary).toContain("• 참여자 2명: 김민수, 이서연");
    expect(summary).toContain("검토·자료 관련 발화 1건");
    expect(summary).toContain("회신 관련 발화 1건");
    expect(summary).not.toContain("자료 검토 부탁합니다");
    expect(summary).not.toContain("내일까지 회신해주세요");

    const todos = stubExtractTodos(sample);
    expect(todos.map((t) => t.title)).toEqual(["자료 검토하기", "회신하기"]);
    expect(todos[0]).toMatchObject({ assignee: "김민수", sourceMessageIds: [1] });
    expect(todos[1]).toMatchObject({ assignee: "이서연", due: "내일", sourceMessageIds: [2] });
    expect(todos.every((t) => t.title !== sample[0].text && t.title !== sample[1].text)).toBe(true);
  });

  it("has an empty-room summary and no todos", () => {
    expect(stubSummarize([])).toBe("[스텁] 요약할 대화가 없습니다.");
    expect(stubExtractTodos([])).toEqual([]);
  });

  it("asks the provider for both summary and todos", async () => {
    const provider = {
      summarize: vi.fn(async () => "  한 줄 요약  "),
      extractTodos: vi.fn(async () => [{ title: "확인하기", assignee: "김민수" }]),
    };
    const result = await new RoomAiService(provider).run(sample);
    expect(provider.summarize).toHaveBeenCalledWith(sample);
    expect(provider.extractTodos).toHaveBeenCalledWith(sample);
    expect(result).toEqual({ summary: "한 줄 요약", todos: [{ title: "확인하기", assignee: "김민수" }] });
  });
});

describe("room AI transcript window", () => {
  it("drops deleted, pending, and failed rows and keeps the newest window", () => {
    const rows = [
      { messageId: 1, sendUserName: "A", message: "남김", deleted: true },
      { messageId: 2, sendUserName: "A", message: "전송중", pending: true },
      { messageId: 3, sendUserName: "A", message: "실패", failed: true },
      { messageId: 4, sendUserName: "A", message: "   " },
      { messageId: 5, sendUserName: "김민수", message: "첫째" },
      { messageId: 6, sendUserName: "이서연", message: "둘째" },
    ];
    expect(toRoomAiMessages(rows)).toEqual([
      { id: 5, sender: "김민수", text: "첫째", createdAt: undefined },
      { id: 6, sender: "이서연", text: "둘째", createdAt: undefined },
    ]);
    const many = Array.from({ length: 5 }, (_, i) => ({ messageId: i + 1, sendUserName: "A", message: `m${i}` }));
    expect(toRoomAiMessages(many, 2).map((m) => m.text)).toEqual(["m3", "m4"]);
  });

  it("fingerprints the visible text, not object identity", () => {
    const a = toRoomAiMessages([{ messageId: 1, sendUserName: "A", message: "안녕" }]);
    const b = toRoomAiMessages([{ messageId: 1, sendUserName: "A", message: "안녕" }]);
    expect(roomAiFingerprint(a)).toBe(roomAiFingerprint(b));
    expect(roomAiFingerprint(toRoomAiMessages([{ messageId: 1, sendUserName: "A", message: "다른말" }]))).not.toBe(roomAiFingerprint(a));
  });
});

describe("room AI foreground gate", () => {
  const base = { fingerprint: "2:abc", savedFingerprint: "2:abc" };

  it("never calls out when the window is unfocused or hidden", () => {
    expect(roomAiShouldRun({ ...base, reason: "open", focused: false, hidden: false })).toBe(false);
    expect(roomAiShouldRun({ ...base, reason: "timer", focused: true, hidden: true })).toBe(false);
    expect(roomAiShouldRun({ ...base, reason: "refresh", focused: false, hidden: false })).toBe(false);
    expect(roomAiShouldRun({ ...base, reason: "refresh", focused: true, hidden: true })).toBe(false);
  });

  it("refreshes on demand and skips an unchanged open or timer", () => {
    expect(roomAiShouldRun({ ...base, reason: "refresh", focused: true, hidden: false })).toBe(true);
    expect(roomAiShouldRun({ ...base, reason: "open", focused: true, hidden: false })).toBe(false);
    expect(roomAiShouldRun({ ...base, reason: "timer", focused: true, hidden: false })).toBe(false);
    expect(roomAiShouldRun({ ...base, reason: "open", focused: true, hidden: false, savedFingerprint: "1:old" })).toBe(true);
    expect(roomAiShouldRun({ reason: "timer", focused: true, hidden: false, fingerprint: "1:a" })).toBe(true);
  });
});

describe("room AI local todos", () => {
  it("keeps a checked todo checked when the same item is extracted again", () => {
    const drafts = [{ title: "자료 검토", assignee: "김민수" }, { title: "회신하기" }];
    const first = mergeRoomAiTodos([], drafts);
    const checked = first.map((t) => (t.title === "자료 검토" ? { ...t, done: true } : t));
    const again = mergeRoomAiTodos(checked, drafts.map((d, i) => ({ ...d, sourceMessageIds: [i + 1] })));
    expect(again.find((t) => t.title === "자료 검토")?.done).toBe(true);
    expect(again.find((t) => t.title === "회신하기")?.done).toBe(false);
    expect(again.find((t) => t.title === "자료 검토")?.sourceMessageIds).toEqual([1]);
    expect(again.map((t) => t.id)).toEqual(drafts.map((d) => roomAiTodoId(d.title, d.assignee)));
  });

  it("persists summary and todos per user and room", () => {
    const storage = memory();
    const record = {
      summary: "[스텁] 요약",
      todos: [{ id: "t1", title: "확인하기", assignee: "김민수", done: false }],
      updatedAt: 10,
      fingerprint: "1:aa",
    };
    saveRoomAi(storage, 7, "room:1", record);
    expect(loadRoomAi(storage, 7, "room:1")).toEqual(record);
    expect(loadRoomAi(storage, 8, "room:1")).toBeNull();
    expect(loadRoomAi(storage, 7, "room:2")).toBeNull();
    const toggled = toggleRoomAiTodo(storage, 7, "room:1", "t1");
    expect(toggled?.todos[0].done).toBe(true);
    expect(loadRoomAi(storage, 7, "room:1")?.todos[0].done).toBe(true);
  });

  it("drops the oldest rooms past the local cap", () => {
    const storage = memory();
    for (let i = 0; i < ROOM_AI_ROOM_LIMIT + 1; i++) {
      saveRoomAi(storage, 7, `room:${i}`, { summary: "s", todos: [], updatedAt: i, fingerprint: "0:0" });
    }
    expect(loadRoomAi(storage, 7, "room:0")).toBeNull();
    expect(loadRoomAi(storage, 7, `room:${ROOM_AI_ROOM_LIMIT}`)?.summary).toBe("s");
  });
});
