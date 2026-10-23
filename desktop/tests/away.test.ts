import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwayMonitor, nextAwayState } from "../electron/core/away";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("nextAwayState", () => {
  it("uses the minutes threshold", () => {
    const base = { awayMinutes: 1, mobileNotice: true, current: false };
    expect(nextAwayState({ ...base, idleSec: 59 })).toBe(false);
    expect(nextAwayState({ ...base, idleSec: 60 })).toBe(true);
    expect(nextAwayState({ ...base, idleSec: 299, awayMinutes: 5 })).toBe(false);
    expect(nextAwayState({ ...base, idleSec: 300, awayMinutes: 5 })).toBe(true);
  });

  it("never goes away when disabled (0)", () => {
    expect(nextAwayState({ idleSec: 999_999, awayMinutes: 0, mobileNotice: true, current: true })).toBe(false);
  });

  it("still marks away when mobileNotice is off (local preference only)", () => {
    expect(nextAwayState({ idleSec: 60, awayMinutes: 1, mobileNotice: false, current: false })).toBe(true);
  });
});

describe("createAwayMonitor", () => {
  it("calls setAway only on change and resets online when disabled", () => {
    vi.useFakeTimers();
    let idleSec = 0;
    const config = { awayMinutes: 1, mobileNotice: true };
    const calls: boolean[] = [];
    const monitor = createAwayMonitor({
      getIdleSec: () => idleSec,
      setAway: (away) => calls.push(away),
      getConfig: () => config,
      intervalMs: 1000,
    });
    monitor.start();

    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([]);

    idleSec = 60;
    vi.advanceTimersByTime(3000);
    expect(calls).toEqual([true]);

    idleSec = 0;
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([true, false]);

    idleSec = 120;
    config.awayMinutes = 0;
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([true, false]);

    monitor.stop();
    idleSec = 500;
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([true, false]);
  });
});
