/**
 * 방해 금지 시간 (Do-Not-Disturb). Pure client-side logic: while active, the main process
 * suppresses desktop notifications and notification sound (badges are unaffected).
 *
 * A schedule is days (0=Sun..6=Sat) + a start/end minute-of-day, with overnight ranges supported
 * (start > end wraps past midnight). A manual "지금부터 N시간" window is stored as an absolute
 * `manualUntil` timestamp.
 */

export type DndConfig = {
  enabled: boolean;
  /** days of week (0=Sun … 6=Sat) the schedule applies to */
  days: number[];
  /** minute of day (0..1439) the quiet period starts */
  startMin: number;
  /** minute of day (0..1439) the quiet period ends (exclusive) */
  endMin: number;
  /** absolute ms timestamp for a manual "지금부터 N시간" window */
  manualUntil?: number;
};

export function minutesOfDay(t: number): number {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
}

export function dayOfWeek(t: number): number {
  return new Date(t).getDay();
}

/** Active when a manual window is open, or the schedule matches the current day + minute. */
export function isInDnd(t: number, cfg: DndConfig): boolean {
  if (cfg.manualUntil != null && Number.isFinite(cfg.manualUntil) && t < cfg.manualUntil) return true;
  if (!cfg.enabled) return false;
  if (!Array.isArray(cfg.days) || cfg.days.length === 0) return false;
  const start = cfg.startMin;
  const end = cfg.endMin;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  const m = minutesOfDay(t);
  const dow = dayOfWeek(t);
  if (start < end) return cfg.days.includes(dow) && m >= start && m < end;
  // Overnight (e.g. 22:00 → 08:00): the morning tail belongs to the day that started the period.
  const yesterday = (dow + 6) % 7;
  return (cfg.days.includes(dow) && m >= start) || (cfg.days.includes(yesterday) && m < end);
}

/** Manual quiet window: now + N hours. */
export function computeManualUntil(now: number, hours: unknown): number {
  const h = typeof hours === "number" ? hours : Number(hours);
  if (!Number.isFinite(h) || h <= 0) throw new Error("방해 금지 시간을 입력하세요");
  return now + Math.round(h * 3600_000);
}

/** Validate a minute-of-day (0..1439). */
export function normalizeDndMin(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || n > 1439) throw new Error("시간은 0~1439분(하루) 사이여야 합니다");
  return n;
}

/** Validate + dedupe + sort a days-of-week array (0..6). */
export function normalizeDndDays(value: unknown): number[] {
  const list = Array.isArray(value) ? value : [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of list) {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
    if (!Number.isInteger(n) || n < 0 || n > 6) throw new Error("요일이 올바르지 않습니다");
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Day-of-week labels (0=Sun), Korean short form for the DND settings UI. */
export const DND_DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"] as const;
