import { describe, it, expect } from "vitest";
import { isRoomCollecting, setRoomCollecting, setManyRoomsCollecting, setAllRooms, type RoomCollectSettings } from "../electron/core/todo/rooms";

const base = (): RoomCollectSettings => ({ allRooms: false, enabledRooms: [], disabledRooms: [] });
const apply = (s: RoomCollectSettings, p: Partial<RoomCollectSettings>) => ({ ...s, ...p });

describe("auto-collect room settings", () => {
  it("default off for every room", () => {
    expect(isRoomCollecting(base(), "r1")).toBe(false);
  });
  it("per-room opt-in only affects that room", () => {
    const s = apply(base(), setRoomCollecting(base(), "r1", true));
    expect(isRoomCollecting(s, "r1")).toBe(true);
    expect(isRoomCollecting(s, "r2")).toBe(false);
  });
  it("all-rooms on enables every room", () => {
    const s = apply(base(), setAllRooms(base(), true));
    expect(isRoomCollecting(s, "anything")).toBe(true);
  });
  it("room toggle off overrides all-rooms (exclusion)", () => {
    let s = apply(base(), setAllRooms(base(), true));
    s = apply(s, setRoomCollecting(s, "r2", false));
    expect(isRoomCollecting(s, "r2")).toBe(false);
    expect(isRoomCollecting(s, "r3")).toBe(true);
    s = apply(s, setRoomCollecting(s, "r2", true));
    expect(isRoomCollecting(s, "r2")).toBe(true);
  });
  it("turning all-rooms off falls back to explicit opt-ins", () => {
    let s = apply(base(), setRoomCollecting(base(), "r1", true));
    s = apply(s, setAllRooms(s, true));
    s = apply(s, setAllRooms(s, false));
    expect(isRoomCollecting(s, "r1")).toBe(true);
    expect(isRoomCollecting(s, "r9")).toBe(false);
  });
  it("select-all / deselect-all over a room list", () => {
    const keys = ["a", "b", "c"];
    let s = apply(base(), setManyRoomsCollecting(base(), keys, true));
    expect(keys.every((k) => isRoomCollecting(s, k))).toBe(true);
    s = apply(s, setManyRoomsCollecting(s, keys, false));
    expect(keys.some((k) => isRoomCollecting(s, k))).toBe(false);
    s = apply(s, setAllRooms(s, true));
    s = apply(s, setManyRoomsCollecting(s, ["a", "b"], false));
    expect([isRoomCollecting(s, "a"), isRoomCollecting(s, "b"), isRoomCollecting(s, "c")]).toEqual([false, false, true]);
  });
});
