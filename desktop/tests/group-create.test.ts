import { afterEach, describe, expect, it, vi } from "vitest";
import { DaouClient, buildCreateGroupRoomPath } from "../electron/core/daou-client";
import { MessengerCore } from "../electron/core/messenger";
import type { Room } from "../electron/core/types";

const reply = (text = "", status = 200) =>
  new Response(text, { status, headers: { "content-type": "application/json" } });

function client() {
  const c = new DaouClient("https://daou.example");
  c.user = { id: 7, repId: 7, name: "나", loginId: "me", companyId: 1 };
  return c;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("create group room path", () => {
  it("dedupes ids, drops invalid ids and my own user id", () => {
    expect(buildCreateGroupRoomPath([2, 3, 3, 0, -1, NaN, Infinity, 7, 2], 7)).toBe(
      "/api/chat/rooms?memberSeq=2&memberSeq=3&userSeq=7"
    );
  });

  it("throws when no other members remain", () => {
    const msg = "대화 상대를 선택하세요";
    expect(() => buildCreateGroupRoomPath([], 7)).toThrow(msg);
    expect(() => buildCreateGroupRoomPath([7, 0, -3, NaN], 7)).toThrow(msg);
  });

  it("sends the exact POST request with a JSON body", async () => {
    const f = vi.fn(async () => reply('{"data":{"roomSeq":55}}'));
    vi.stubGlobal("fetch", f);
    await expect(client().createGroupRoom([2, 3, 3])).resolves.toBe(55);
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://daou.example/api/chat/rooms?memberSeq=2&memberSeq=3&userSeq=7");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body.toString()).toBe("{}");
  });

  it("rejects a response without a positive finite roomSeq", async () => {
    for (const text of ['{"data":{}}', '{"data":{"roomSeq":0}}', '{"data":{"roomSeq":-2}}', '{"data":{"roomSeq":"x"}}']) {
      vi.stubGlobal("fetch", vi.fn(async () => reply(text)));
      await expect(client().createGroupRoom([2])).rejects.toThrow("그룹 대화방을 만들지 못했습니다");
      vi.unstubAllGlobals();
    }
  });
});

describe("MessengerCore.createGroup", () => {
  it("adds a fallback room and keeps it across refreshes until the server lists it", async () => {
    const core = new MessengerCore("https://daou.example");
    core.client.user = { id: 7, repId: 7, name: "나", loginId: "me", companyId: 1 };
    (core as any).usersCache = [
      { userId: 2, name: "김철수", position: "", email: "", thumbnail: "", departmentIds: [] },
      { userId: 3, name: "이영희", position: "", email: "", thumbnail: "", departmentIds: [] },
    ];
    vi.spyOn(core.client, "createGroupRoom").mockResolvedValue(55);
    const listRooms = vi.spyOn(core.client, "listRooms").mockResolvedValue([]);
    const onRooms = vi.fn();
    core.on("rooms", onRooms);

    const room = await core.createGroup([2, 3]);
    expect(room).toMatchObject({ key: "room:55", kind: "room", seq: 55, name: "김철수, 이영희" });
    expect(core.getRooms().some((r) => r.key === "room:55")).toBe(true);
    expect(onRooms).toHaveBeenCalled();
    expect((core as any).pendingGroupRooms.has("room:55")).toBe(true);

    // The server list still does not know the brand-new room yet.
    await core.refreshRooms();
    expect(core.getRooms().find((r) => r.key === "room:55")?.name).toBe("김철수, 이영희");

    // Once the server reports it, the pending fallback is dropped.
    const serverRoom: Room = {
      key: "room:55", kind: "room", seq: 55, name: "서버 이름", preview: "", unread: 0,
      usePin: false, usePush: true, avatar: "", isSelf: false,
    };
    listRooms.mockResolvedValue([serverRoom]);
    await core.refreshRooms();
    expect(core.getRooms().find((r) => r.key === "room:55")?.name).toBe("서버 이름");
    expect((core as any).pendingGroupRooms.has("room:55")).toBe(false);
    core.shutdown();
  });

  it("keeps the created room when the follow-up refresh fails", async () => {
    const core = new MessengerCore("https://daou.example");
    core.client.user = { id: 7, repId: 7, name: "나", loginId: "me", companyId: 1 };
    vi.spyOn(core.client, "createGroupRoom").mockResolvedValue(56);
    vi.spyOn(core.client, "listRooms").mockRejectedValue(new Error("network"));
    const room = await core.createGroup([2, 3]);
    expect(room.key).toBe("room:56");
    expect(core.getRooms().some((r) => r.key === "room:56")).toBe(true);
    core.shutdown();
  });
});
