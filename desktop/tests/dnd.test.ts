import { describe, expect, it } from "vitest";
import {
  computeManualUntil, dayOfWeek, isInDnd, minutesOfDay, normalizeDndDays, normalizeDndMin,
} from "../electron/core/dnd";

// Build local timestamps so getDay()/getHours() match the test machine's timezone.
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi, 0, 0).getTime();

describe("dnd: time helpers", () => {
  it("computes minutes-of-day and day-of-week", () => {
    expect(minutesOfDay(local(2026, 9, 24, 10, 30))).toBe(10 * 60 + 30);
    const t = local(2026, 9, 24, 10, 0);
    expect(dayOfWeek(t)).toBe(new Date(t).getDay());
  });
});

describe("dnd: isInDnd", () => {
  it("is off when disabled", () => {
    const t = local(2026, 9, 24, 10, 0);
    expect(isInDnd(t, { enabled: false, days: [dayOfWeek(t)], startMin: 0, endMin: 1439 })).toBe(false);
  });

  it("requires a matching day", () => {
    const t = local(2026, 9, 24, 10, 0); // a Saturday in KST, but we just use its local weekday
    const cfg = { enabled: true, days: [(dayOfWeek(t) + 1) % 7], startMin: 0, endMin: 1439 };
    expect(isInDnd(t, cfg)).toBe(false);
    expect(isInDnd(t, { ...cfg, days: [dayOfWeek(t)] })).toBe(true);
  });

  it("handles a same-day window", () => {
    const cfg = { enabled: true, days: [dayOfWeek(local(2026, 9, 24, 10, 0))], startMin: 540, endMin: 720 }; // 09:00–12:00
    expect(isInDnd(local(2026, 9, 24, 8, 59), cfg)).toBe(false);
    expect(isInDnd(local(2026, 9, 24, 9, 0), cfg)).toBe(true);
    expect(isInDnd(local(2026, 9, 24, 11, 59), cfg)).toBe(true);
    expect(isInDnd(local(2026, 9, 24, 12, 0), cfg)).toBe(false);
  });

  it("handles an overnight window (start > end)", () => {
    const dow = dayOfWeek(local(2026, 9, 24, 10, 0));
    const cfg = { enabled: true, days: [dow], startMin: 1320, endMin: 480 }; // 22:00 → 08:00
    expect(isInDnd(local(2026, 9, 24, 21, 59), cfg)).toBe(false);
    expect(isInDnd(local(2026, 9, 24, 22, 0), cfg)).toBe(true);
    expect(isInDnd(local(2026, 9, 25, 3, 0), cfg)).toBe(true);
    expect(isInDnd(local(2026, 9, 25, 8, 0), cfg)).toBe(false);
  });

  it("overnight morning tail requires the previous day to be selected", () => {
    const dow = dayOfWeek(local(2026, 9, 24, 10, 0));
    const cfg = { enabled: true, days: [dow], startMin: 1320, endMin: 480 };
    // Morning of the day AFTER the selected day: not active unless that day started a period.
    expect(isInDnd(local(2026, 9, 26, 3, 0), cfg)).toBe(false);
  });

  it("honors the manual window regardless of schedule", () => {
    const t = local(2026, 9, 24, 10, 0);
    const cfg = { enabled: false, days: [], startMin: 0, endMin: 0, manualUntil: t + 60_000 };
    expect(isInDnd(t, cfg)).toBe(true);
    expect(isInDnd(t + 60_000, cfg)).toBe(false);
  });
});

describe("dnd: manual + normalization", () => {
  it("computeManualUntil adds N hours", () => {
    expect(computeManualUntil(1_000_000, 1)).toBe(1_000_000 + 3600_000);
    expect(computeManualUntil(1_000_000, "2")).toBe(1_000_000 + 2 * 3600_000);
    expect(() => computeManualUntil(1_000_000, 0)).toThrow();
    expect(() => computeManualUntil(1_000_000, Number.NaN)).toThrow();
  });

  it("normalizes minutes and days", () => {
    expect(normalizeDndMin(0)).toBe(0);
    expect(normalizeDndMin(1439)).toBe(1439);
    expect(() => normalizeDndMin(1440)).toThrow();
    expect(() => normalizeDndMin(-1)).toThrow();
    expect(normalizeDndDays([6, 1, 6, 3])).toEqual([1, 3, 6]);
    expect(() => normalizeDndDays([7])).toThrow();
    expect(() => normalizeDndDays([-1])).toThrow();
    expect(normalizeDndDays([])).toEqual([]);
  });
});
