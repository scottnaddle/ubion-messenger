import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dueReminders, nextDueAt, nextNineAm, normalizeReminderInput, normalizeReminderPreset, pendingReminders,
  presetDelayMs, reminderDueAt, REMINDER_MAX_ITEMS, ReminderStore, type Reminder, type ReminderPreset,
} from "../electron/core/reminders";
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

const reminder = (over: Partial<Reminder> = {}): Reminder => ({
  id: "r1",
  roomKey: "room:1",
  roomName: "회의방",
  messageId: 5,
  message: "내일 회의 자료",
  sendUserName: "김하늘",
  createdAt: "2026-10-24T10:00:00.000Z",
  dueAt: 1_700_000_000_000,
  created: 1_699_000_000_000,
  ...over,
});

// 2026-10-24 10:00:00 KST (UTC+9)
const NOW = Date.parse("2026-10-24T10:00:00.000+09:00");

afterEach(() => {
  vi.useRealTimers();
});

describe("reminders: scheduling math", () => {
  it("computes preset delays", () => {
    expect(presetDelayMs("20m", NOW)).toBe(20 * 60_000);
    expect(presetDelayMs("1h", NOW)).toBe(60 * 60_000);
    expect(presetDelayMs("3h", NOW)).toBe(3 * 60 * 60_000);
  });

  it("내일 오전 9시 is the next 9 AM local time", () => {
    // NOW is 2026-10-24 10:00 KST → next is 2026-10-25 09:00 KST
    const expected = Date.parse("2026-10-25T09:00:00.000+09:00");
    expect(nextNineAm(NOW)).toBe(expected);
    expect(reminderDueAt("tomorrow9", NOW)).toBe(expected);
  });

  it("20m/1h/3h dueAt = now + delay", () => {
    expect(reminderDueAt("20m", NOW)).toBe(NOW + 20 * 60_000);
    expect(reminderDueAt("1h", NOW)).toBe(NOW + 60 * 60_000);
    expect(reminderDueAt("3h", NOW)).toBe(NOW + 3 * 60 * 60_000);
  });

  it("custom dueAt must be in the future", () => {
    expect(reminderDueAt("custom", NOW, NOW + 5_000)).toBe(NOW + 5_000);
    expect(() => reminderDueAt("custom", NOW, NOW)).toThrow();
    expect(() => reminderDueAt("custom", NOW, NOW - 1)).toThrow();
    expect(() => reminderDueAt("custom", NOW, undefined)).toThrow();
    expect(() => reminderDueAt("custom", NOW, Number.NaN)).toThrow();
  });

  it("normalizes presets strictly", () => {
    for (const p of ["20m", "1h", "3h", "tomorrow9", "custom"] as ReminderPreset[]) {
      expect(normalizeReminderPreset(p)).toBe(p);
    }
    expect(() => normalizeReminderPreset("5m")).toThrow();
    expect(() => normalizeReminderPreset(undefined)).toThrow();
  });
});

describe("reminders: due classification", () => {
  const past = reminder({ id: "past", dueAt: NOW - 1 });
  const now = reminder({ id: "now", dueAt: NOW });
  const future = reminder({ id: "future", dueAt: NOW + 60_000 });

  it("splits due vs pending", () => {
    expect(dueReminders([past, now, future], NOW).map((r) => r.id)).toEqual(["past", "now"]);
    expect(pendingReminders([past, now, future], NOW).map((r) => r.id)).toEqual(["future"]);
    expect(dueReminders([], NOW)).toEqual([]);
  });

  it("returns the earliest future dueAt for the timer", () => {
    expect(nextDueAt([past, now, future], NOW)).toBe(NOW + 60_000);
    expect(nextDueAt([past, now], NOW)).toBeNull();
    expect(nextDueAt([], NOW)).toBeNull();
  });
});

describe("reminders: normalizeReminderInput", () => {
  it("validates and computes dueAt", () => {
    expect(normalizeReminderInput({ roomKey: "room:1", message: "m", preset: "20m" }, NOW)).toEqual({
      roomKey: "room:1", roomName: "", message: "m", sendUserName: "", messageId: undefined,
      createdAt: undefined, dueAt: NOW + 20 * 60_000,
    });
    expect(() => normalizeReminderInput({ roomKey: " ", preset: "20m" }, NOW)).toThrow();
    expect(() => normalizeReminderInput({ roomKey: "room:1", preset: "custom" }, NOW)).toThrow();
    expect(normalizeReminderInput({ roomKey: "room:1", preset: "custom", customAt: NOW + 1 }, NOW).dueAt).toBe(NOW + 1);
  });
});

describe("reminders: store (fake fs, client-local)", () => {
  it("persists per user, reloads, removes, and caps at REMINDER_MAX_ITEMS", () => {
    const fs = fakeFs();
    const store = new ReminderStore("/ud/reminders", fs, { maxItems: 2 });
    store.for(42);
    const a = store.add({ roomKey: "room:1", roomName: "", message: "a", sendUserName: "", dueAt: NOW + 1 }, NOW);
    store.add({ roomKey: "room:1", roomName: "", message: "b", sendUserName: "", dueAt: NOW + 2 }, NOW);
    store.add({ roomKey: "room:1", roomName: "", message: "c", sendUserName: "", dueAt: NOW + 3 }, NOW);
    expect(store.list().map((r) => r.message)).toEqual(["c", "b"]);
    store.flush();
    expect([...fs.files.keys()]).toEqual(["/ud/reminders/42.json"]);
    const again = new ReminderStore("/ud/reminders", fs);
    expect(again.for(42).map((r) => r.message)).toEqual(["c", "b"]);
    expect(again.remove(a.id)).toBe(false); // already evicted
    expect(again.remove(again.list()[0].id)).toBe(true);
  });

  it("removeDue fires (and persists) only past-due reminders", () => {
    const fs = fakeFs();
    const store = new ReminderStore("/ud/reminders", fs);
    store.for(42);
    store.add({ roomKey: "room:1", roomName: "", message: "past", sendUserName: "", dueAt: NOW - 5 }, NOW);
    store.add({ roomKey: "room:1", roomName: "", message: "future", sendUserName: "", dueAt: NOW + 5 }, NOW);
    expect(store.removeDue(NOW)).toBe(1);
    expect(store.list().map((r) => r.message)).toEqual(["future"]);
    store.flush();
    expect(new ReminderStore("/ud/reminders", fs).for(42).map((r) => r.message)).toEqual(["future"]);
  });

  it("treats corrupt files as empty and requires login before add", () => {
    const fs = fakeFs();
    fs.files.set("/ud/reminders/42.json", "{oops");
    expect(new ReminderStore("/ud/reminders", fs).for(42)).toEqual([]);
    const anon = new ReminderStore("/ud/reminders", fakeFs());
    expect(() => anon.add({ roomKey: "r", roomName: "", message: "x", sendUserName: "", dueAt: NOW + 1 }, NOW)).toThrow();
  });
});
