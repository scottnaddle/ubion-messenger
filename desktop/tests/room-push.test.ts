import { afterEach, describe, expect, it, vi } from "vitest";
import { DaouClient } from "../electron/core/daou-client";
import { MessengerCore } from "../electron/core/messenger";
import { ROOM_PUSH, ROOM_PUSH_METHOD, buildRoomPushPath, roomPushPath, shouldNotify } from "../electron/core/room-push";
import type { Room } from "../electron/core/types";

const reply = (text = "", status = 200) =>
  new Response(text, { status, headers: { "content-type": "application/json" } });

function client() {
  const c = new DaouClient("https://daou.example");
  c.user = { id: 42, repId: 42, name: "나", loginId: "me", companyId: 1 };
  return c;
}

function messenger(overrides: Partial<Room> = {}) {
  const core = new MessengerCore("https://daou.example");
  core.client.user = { id: 42, repId: 42, name: "나", loginId: "me", companyId: 1 };
  const room: Room = {
    key: "room:7", kind: "room", seq: 7, name: "방", preview: "", unread: 0,
    usePin: false, usePush: true, avatar: "", isSelf: false, ...overrides,
  };
  (core as any).rooms.set(room.key, room);
  return { core, room };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("room push (fake network)", () => {
  it("builds the exact official path with literal true/false and no body", () => {
    expect(roomPushPath("room", 7, 42, true)).toBe("/api/chat/rooms/7/push?userSeq=42&usePush=true");
    expect(roomPushPath("room", 7, 42, false)).toBe("/api/chat/rooms/7/push?userSeq=42&usePush=false");
    expect(buildRoomPushPath("buddy", 9, 1, false)).toBe("/api/chat/buddies/9/push?userSeq=1&usePush=false");
    expect(ROOM_PUSH("pubsub", 9, 1, true)).toBe("/api/chat/pubsubs/9/push?userSeq=1&usePush=true");
    expect(ROOM_PUSH_METHOD).toBe("PUT");
    expect(() => roomPushPath("unknown", 1, 1, true)).toThrow();
  });

  it("decides notifications: own messages never, mentions override muted rooms", () => {
    expect(shouldNotify({ usePush: true, mentioned: false, isMine: false })).toBe(true);
    expect(shouldNotify({ usePush: false, mentioned: false, isMine: false })).toBe(false);
    expect(shouldNotify({ usePush: false, mentioned: true, isMine: false })).toBe(true);
    expect(shouldNotify({ usePush: true, mentioned: true, isMine: true })).toBe(false);
    expect(shouldNotify({ usePush: true, mentioned: false, isMine: true })).toBe(false);
  });

  it("PUTs to the exact URL with no request body and JSON content type", async () => {
    const f = vi.fn(async () => reply());
    vi.stubGlobal("fetch", f);
    await client().setRoomPush("room", 7, false);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://daou.example/api/chat/rooms/7/push?userSeq=42&usePush=false");
    expect(init.method).toBe("PUT");
    expect(init.body).toBeUndefined();
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("updates the messenger room state and emits rooms so the UI reflects it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply()));
    const core = new MessengerCore("https://daou.example");
    core.client.user = { id: 42, repId: 42, name: "나", loginId: "me", companyId: 1 };
    const room: Room = {
      key: "room:7", kind: "room", seq: 7, name: "방", preview: "", unread: 0,
      usePin: false, usePush: true, avatar: "", isSelf: false,
    };
    (core as any).rooms.set(room.key, room);
    const onRooms = vi.fn();
    core.on("rooms", onRooms);
    await core.setRoomPush(room.key, false);
    expect(room.usePush).toBe(false);
    expect(onRooms).toHaveBeenCalled();
    expect(onRooms.mock.calls.at(-1)![0][0]).toMatchObject({ key: "room:7", usePush: false });
  });

  it("throws for an unknown room key without touching the network", async () => {
    const { core } = messenger();
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(core.setRoomPush("room:999", false)).rejects.toThrow("알 수 없는");
    expect(f).not.toHaveBeenCalled();
  });

  it("rolls the optimistic toggle back when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply('{"message":"no"}', 500)));
    const { core, room } = messenger();
    const onRooms = vi.fn();
    core.on("rooms", onRooms);
    await expect(core.setRoomPush(room.key, false)).rejects.toThrow();
    expect(room.usePush).toBe(true);
    expect(onRooms.mock.calls.at(-1)![0][0]).toMatchObject({ key: "room:7", usePush: true });
  });

  it("keeps a pending override across refreshRooms until the server agrees", async () => {
    const { core, room } = messenger();
    let finish: (r: Response) => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    let serverPush = true;
    const listRooms = vi.spyOn(core.client, "listRooms").mockImplementation(async () => [
      { ...room, usePush: serverPush },
    ]);

    const pending = core.setRoomPush(room.key, false);
    expect(room.usePush).toBe(false);

    // A refresh while the PUT is still in flight reports the old server value.
    await core.refreshRooms();
    expect(core.getRooms().find((r) => r.key === room.key)!.usePush).toBe(false);

    finish(reply());
    await pending;
    expect(core.getRooms().find((r) => r.key === room.key)!.usePush).toBe(false);

    // Server now reports the new value: the override is no longer needed.
    serverPush = false;
    await core.refreshRooms();
    expect(core.getRooms().find((r) => r.key === room.key)!.usePush).toBe(false);

    // With the override cleared, a later differing server value wins again.
    serverPush = true;
    await core.refreshRooms();
    expect(core.getRooms().find((r) => r.key === room.key)!.usePush).toBe(true);
    expect(listRooms).toHaveBeenCalledTimes(3);
  });
});
