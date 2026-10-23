import { afterEach, describe, expect, it, vi } from "vitest";
import { DaouClient, HttpError } from "../electron/core/daou-client";
import {
  apiRoomSeq, checkForwardTarget, cryptAttachTexts, FORWARD_MAX_MEMBERS, forwardMembersPath, forwardRoomPath,
  normalizeForwardMembers, normalizeForwardRoomType,
} from "../electron/core/forward";
import type { Room } from "../electron/core/types";

const reply = (text = "", status = 200) =>
  new Response(text, { status, headers: { "content-type": "application/json" } });

function client() {
  const c = new DaouClient("https://daou.example");
  c.user = { id: 42, repId: 42, name: "나", loginId: "me", companyId: 1 };
  return c;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("forward (fake network)", () => {
  it("extracts cryptIds from attachment models and rejects empty input", () => {
    expect(cryptAttachTexts([{ cryptId: "a" }, { cryptId: "b c" }])).toEqual(["a", "b c"]);
    expect(cryptAttachTexts(["x", { cryptAttachText: "y" }])).toEqual(["x", "y"]);
    expect(() => cryptAttachTexts([])).toThrow();
    expect(() => cryptAttachTexts([{ name: "no id" }])).toThrow();
  });

  it("builds the exact room path with encoded values", () => {
    expect(forwardRoomPath(7, ["a", "b c"], 42)).toBe(
      "/api/chat/forward/attaches/room?roomSeq=7&cryptAttachText=a&cryptAttachText=b%20c&userSeq=42"
    );
    expect(forwardRoomPath("8", [{ cryptId: "x/y" }], "42")).toContain("cryptAttachText=x%2Fy");
  });

  it("builds member paths for single/group and validates inputs", () => {
    expect(forwardMembersPath([3, 4], ["c"], "single", 42)).toBe(
      "/api/chat/forward/attaches?roomType=single&memberSeq=3&memberSeq=4&cryptAttachText=c&userSeq=42"
    );
    expect(forwardMembersPath([3, 3], ["c"], "group", 42)).toContain("memberSeq=3&cryptAttachText=c");
    expect(normalizeForwardRoomType("GROUP")).toBe("group");
    expect(() => normalizeForwardRoomType("room")).toThrow();
    expect(() => forwardRoomPath(0, ["a"], 42)).toThrow();
    expect(() => forwardRoomPath(7, [], 42)).toThrow();
    expect(() => forwardMembersPath([], ["a"], "single", 42)).toThrow();
    expect(() => forwardMembersPath(Array.from({ length: FORWARD_MAX_MEMBERS + 1 }, (_, i) => i + 1), ["a"], "group", 42)).toThrow();
    expect(normalizeForwardMembers([3, "3", 4])).toEqual([3, 4]);
  });

  it("uses buddyRoomSeq (not the peer user id) for buddy rooms", () => {
    const self: Room = {
      key: "buddy:42", kind: "buddy", seq: 42, buddyRoomSeq: 777, name: "나", preview: "",
      unread: 0, usePin: false, usePush: true, avatar: "", isSelf: true, peerUserId: 42,
    };
    expect(apiRoomSeq(self)).toBe(777);
    expect(() => apiRoomSeq({ ...self, buddyRoomSeq: undefined })).toThrow("대화방 번호를 확인할 수 없습니다");
    expect(apiRoomSeq({ ...self, kind: "room", seq: 321, buddyRoomSeq: undefined })).toBe(321);
    expect(apiRoomSeq({ ...self, kind: "pubsub", seq: 55, buddyRoomSeq: undefined })).toBe(55);
    expect(forwardRoomPath(apiRoomSeq(self), ["a"], 42)).toContain("roomSeq=777");
    expect(() => checkForwardTarget({ selfOnly: true, target: { roomSeq: apiRoomSeq(self) }, me: 42, selfRoomSeq: apiRoomSeq(self) })).not.toThrow();
    expect(() => checkForwardTarget({ selfOnly: true, target: { roomSeq: self.seq }, me: 42, selfRoomSeq: apiRoomSeq(self) })).toThrow();
  });

  it("guards self-only forwards", () => {
    expect(() => checkForwardTarget({ selfOnly: false, target: { roomSeq: 9 }, me: 42, selfRoomSeq: 7 })).not.toThrow();
    expect(() => checkForwardTarget({ selfOnly: true, target: { roomSeq: 7 }, me: 42, selfRoomSeq: 7 })).not.toThrow();
    expect(() => checkForwardTarget({ selfOnly: true, target: { memberSeqs: [42] }, me: 42, selfRoomSeq: 7 })).not.toThrow();
    expect(() => checkForwardTarget({ selfOnly: true, target: { roomSeq: 9 }, me: 42, selfRoomSeq: 7 })).toThrow();
    expect(() => checkForwardTarget({ selfOnly: true, target: { memberSeqs: [42, 43] }, me: 42, selfRoomSeq: 7 })).toThrow();
  });

  it("POSTs an empty form-urlencoded body to the room endpoint", async () => {
    const f = vi.fn(async () => reply('{"code":"200"}'));
    vi.stubGlobal("fetch", f);
    await expect(client().forwardToRoom(7, ["a", "b"])).resolves.toEqual({ ok: true, count: 2 });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://daou.example/api/chat/forward/attaches/room?roomSeq=7&cryptAttachText=a&cryptAttachText=b&userSeq=42");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("POSTs to the members endpoint and surfaces HTTP errors", async () => {
    const f = vi.fn(async () => reply('{"code":"200"}'));
    vi.stubGlobal("fetch", f);
    await expect(client().forwardToMembers([3, 4], ["c"], "single")).resolves.toEqual({ ok: true, count: 1 });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://daou.example/api/chat/forward/attaches?roomType=single&memberSeq=3&memberSeq=4&cryptAttachText=c&userSeq=42");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();

    vi.stubGlobal("fetch", vi.fn(async () => reply('{"message":"no"}', 403)));
    const err = await client().forwardToRoom(7, ["a"]).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
  });

  it("rejects invalid cryptIds without calling fetch", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(client().forwardToRoom(7, [])).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});
