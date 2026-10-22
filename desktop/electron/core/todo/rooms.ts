/** Room opt-in logic for chat auto-collect. Pure (testable). */
export type RoomCollectSettings = { allRooms: boolean; enabledRooms: string[]; disabledRooms: string[] };

/** allRooms on → every room except disabledRooms; off → only enabledRooms. */
export function isRoomCollecting(s: RoomCollectSettings, roomKey: string): boolean {
  return s.allRooms ? !s.disabledRooms.includes(roomKey) : s.enabledRooms.includes(roomKey);
}

/** Per-room toggle; overrides the all-rooms default. Returns a settings patch. */
export function setRoomCollecting(s: RoomCollectSettings, roomKey: string, on: boolean): Partial<RoomCollectSettings> {
  const en = new Set(s.enabledRooms), dis = new Set(s.disabledRooms);
  if (on) { en.add(roomKey); dis.delete(roomKey); } else { en.delete(roomKey); dis.add(roomKey); }
  return { enabledRooms: [...en], disabledRooms: [...dis] };
}

/** Select-all / deselect-all over a visible room list. */
export function setManyRoomsCollecting(s: RoomCollectSettings, roomKeys: string[], on: boolean): Partial<RoomCollectSettings> {
  let cur: RoomCollectSettings = { ...s, enabledRooms: [...s.enabledRooms], disabledRooms: [...s.disabledRooms] };
  for (const k of roomKeys) cur = { ...cur, ...setRoomCollecting(cur, k, on) };
  return { enabledRooms: cur.enabledRooms, disabledRooms: cur.disabledRooms };
}

/** Toggle all-rooms mode; clears stale exclusions when turning on so behavior is predictable. */
export function setAllRooms(s: RoomCollectSettings, on: boolean): Partial<RoomCollectSettings> {
  return on ? { allRooms: true, disabledRooms: [] } : { allRooms: false };
}
