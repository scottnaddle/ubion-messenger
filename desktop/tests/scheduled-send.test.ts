import { describe, expect, it } from "vitest";
import {
  dueScheduled, guardScheduledTarget, missedScheduled, nextScheduledAt, normalizeScheduledInput,
  pendingScheduled, SCHEDULED_MAX_ITEMS, ScheduledStore, type ScheduledMessage,
} from "../electron/core/scheduled-send";
import type { CacheFs } from "../electron/core/search-cache";

const fakeFs = () => {
  const files = new Map<string, string>();
  const fs: CacheFs & { files: Map<string, string> } = {
    files,
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error("ENOENT");
      return files.get(p)!;
    },
    writeFileSync: (p, d) => void files.set(p, d),
    renameSync: (a, b) => {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    mkdirSync: () => undefined,
    rmSync: (p) => {
      for (const k of [...files.keys()]) if (k.startsWith(p)) files.delete(k);
    },
  };
  return fs;
};

const NOW = Date.parse("2026-10-24T10:00:00.000+09:00");

const item = (over: Partial<ScheduledMessage> = {}): ScheduledMessage => ({
  id: "s1",
  roomKey: "room:1",
  roomName: "회의방",
  text: "내일 회의 자료",
  sendAt: NOW + 60_000,
  sendOnMissedLaunch: false,
  state: "scheduled",
  created: NOW,
  ...over,
});

describe("scheduled send: normalization", () => {
  it("validates the input", () => {
    expect(normalizeScheduledInput({ roomKey: "room:1", text: "안녕", sendAt: NOW + 1 }, NOW)).toEqual({
      roomKey: "room:1", roomName: "", text: "안녕", sendAt: NOW + 1, sendOnMissedLaunch: false,
    });
    expect(() => normalizeScheduledInput({ roomKey: " ", text: "x", sendAt: NOW + 1 }, NOW)).toThrow();
    expect(() => normalizeScheduledInput({ roomKey: "room:1", text: " ", sendAt: NOW + 1 }, NOW)).toThrow();
    expect(() => normalizeScheduledInput({ roomKey: "room:1", text: "x", sendAt: NOW }, NOW)).toThrow();
    expect(() => normalizeScheduledInput({ roomKey: "room:1", text: "x", sendAt: NOW - 1 }, NOW)).toThrow();
    expect(normalizeScheduledInput({ roomKey: "room:1", text: "x", sendAt: NOW + 1, sendOnMissedLaunch: true }, NOW).sendOnMissedLaunch).toBe(true);
  });

  it("caps the message length", () => {
    expect(() => normalizeScheduledInput({ roomKey: "room:1", text: "x".repeat(4001), sendAt: NOW + 1 }, NOW)).toThrow();
  });
});

describe("scheduled send: classification", () => {
  const due = item({ id: "due", sendAt: NOW - 1 });
  const now = item({ id: "now", sendAt: NOW });
  const future = item({ id: "future", sendAt: NOW + 60_000 });
  const missed = item({ id: "missed", state: "missed", sendAt: NOW - 1 });

  it("splits due / pending / missed", () => {
    expect(dueScheduled([due, now, future, missed], NOW).map((s) => s.id)).toEqual(["due", "now"]);
    expect(pendingScheduled([due, now, future, missed], NOW).map((s) => s.id)).toEqual(["future"]);
    expect(missedScheduled([due, now, future, missed]).map((s) => s.id)).toEqual(["missed"]);
  });

  it("returns the earliest future sendAt", () => {
    expect(nextScheduledAt([due, future], NOW)).toBe(NOW + 60_000);
    expect(nextScheduledAt([due], NOW)).toBeNull();
    expect(nextScheduledAt([], NOW)).toBeNull();
  });
});

describe("scheduled send: store (fake fs, client-local)", () => {
  it("persists per user, reloads, removes, marks missed and caps items", () => {
    const fs = fakeFs();
    const store = new ScheduledStore("/ud/scheduled", fs, { maxItems: 2 });
    store.for(42);
    const a = store.add({ roomKey: "room:1", roomName: "", text: "a", sendAt: NOW + 1 }, NOW);
    store.add({ roomKey: "room:1", roomName: "", text: "b", sendAt: NOW + 2 }, NOW);
    store.add({ roomKey: "room:1", roomName: "", text: "c", sendAt: NOW + 3 }, NOW);
    expect(store.list().map((s) => s.text)).toEqual(["c", "b"]);
    store.flush();
    expect([...fs.files.keys()]).toEqual(["/ud/scheduled/42.json"]);
    const again = new ScheduledStore("/ud/scheduled", fs);
    expect(again.for(42).map((s) => s.text)).toEqual(["c", "b"]);
    expect(again.remove(a.id)).toBe(false); // evicted
    expect(again.markMissed(again.list()[0].id)).toBe(true);
    expect(again.markMissed(again.list()[0].id)).toBe(false); // already missed
    expect(again.list()[0].state).toBe("missed");
  });

  it("treats corrupt files as empty and requires login before add", () => {
    const fs = fakeFs();
    fs.files.set("/ud/scheduled/42.json", "{oops");
    expect(new ScheduledStore("/ud/scheduled", fs).for(42)).toEqual([]);
    const anon = new ScheduledStore("/ud/scheduled", fakeFs());
    expect(() => anon.add({ roomKey: "r", roomName: "", text: "x", sendAt: NOW + 1 }, NOW)).toThrow();
  });
});

describe("scheduled send: self-only guard reuse", () => {
  const selfRoom = { kind: "room" as const, seq: 99, buddyRoomSeq: undefined };
  const otherRoom = { kind: "room" as const, seq: 7, buddyRoomSeq: undefined };
  const buddySelf = { kind: "buddy" as const, seq: 5, buddyRoomSeq: 99 };

  it("allows the self room and blocks others in safe mode", () => {
    expect(() => guardScheduledTarget({ selfOnly: true, me: 5, selfRoomSeq: 99, room: selfRoom })).not.toThrow();
    expect(() => guardScheduledTarget({ selfOnly: true, me: 5, selfRoomSeq: 99, room: otherRoom })).toThrow();
    expect(() => guardScheduledTarget({ selfOnly: true, me: 5, selfRoomSeq: 99, room: buddySelf })).not.toThrow();
  });

  it("does nothing when self-only is off, and throws on a missing room", () => {
    expect(() => guardScheduledTarget({ selfOnly: false, me: 5, selfRoomSeq: 99, room: otherRoom })).not.toThrow();
    expect(() => guardScheduledTarget({ selfOnly: true, me: 5, selfRoomSeq: 99, room: null })).toThrow();
  });
});
