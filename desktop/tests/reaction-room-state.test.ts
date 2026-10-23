import { describe, expect, it, vi } from "vitest";
import { REACTION_ROOM_INITIAL, reactionRoomFailed, reactionRoomOk, reactionRoomReason } from "../src/lib/reactions";
import { createReactionsClient, REACTION_ROOM_FORBIDDEN } from "../electron/core/reactions";

const F = REACTION_ROOM_FORBIDDEN;
describe("reaction room state", () => {
  it("keeps the UI after it has worked once, even across repeated transient failures", () => {
    let st = reactionRoomOk();
    for (let i = 0; i < 5; i++) st = reactionRoomFailed(st, "세션이 만료되었습니다. 다시 로그인하세요.", F);
    expect(st.blocked).toBeNull();
    expect(reactionRoomReason(true, true, st)).toBeNull();
  });
  it("tolerates one failure during a slow first sign-in, then reports offline", () => {
    const one = reactionRoomFailed(REACTION_ROOM_INITIAL, "리액션 서버에 연결할 수 없습니다.", F);
    expect(reactionRoomReason(true, true, one)).toBeNull();
    const two = reactionRoomFailed(one, "리액션 서버에 연결할 수 없습니다.", F);
    expect(reactionRoomReason(true, true, two)).toBe("봇 서버 연결 안 됨");
    expect(reactionRoomReason(true, true, reactionRoomOk())).toBeNull();
  });
  it("403 (bot not in room) disables with its own reason instead of hiding", () => {
    const st = reactionRoomFailed(REACTION_ROOM_INITIAL, F, F);
    expect(reactionRoomReason(true, true, st)).toBe("봇이 이 대화방에 없음");
  });
});

describe("reactions client 403", () => {
  it("maps a membership 403 to the forbidden message", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 403 }));
    const c = createReactionsClient({ baseUrl: "https://x", getUserSeq: () => 5, getSessionHeader: async () => "t", fetch: fetchImpl } as never);
    expect(await c.list(1, [1])).toEqual({ ok: false, message: F });
  });
});
