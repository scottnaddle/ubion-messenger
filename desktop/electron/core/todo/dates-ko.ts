/**
 * Korean (and mixed) relative / absolute date-time normalizer.
 * Anchor = message createdAt in Asia/Seoul. Pure — no Electron deps.
 */
import type { DatePrecision, NormalizedDate } from "./types";

const DOW: Record<string, number> = {
  일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function pad(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

/** Format a Date as ISO-like with +09:00 (KST wall clock of the Date's UTC fields if we built via Date.UTC+offset). */
export function formatKst(y: number, m: number, d: number, h = 18, mi = 0, s = 0): string {
  return `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}+09:00`;
}

/** Parse ISO / Date into KST wall components. */
export function toKstParts(anchor: Date | string): { y: number; m: number; d: number; h: number; mi: number; dow: number; date: Date } {
  const d = typeof anchor === "string" ? new Date(anchor) : anchor;
  // Use Intl to get Asia/Seoul parts
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const y = Number(parts.year);
  const m = Number(parts.month);
  const day = Number(parts.day);
  let h = Number(parts.hour);
  if (h === 24) h = 0;
  const mi = Number(parts.minute);
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = wdMap[parts.weekday] ?? d.getUTCDay();
  return { y, m, d: day, h, mi, dow, date: d };
}

function addDays(y: number, m: number, d: number, n: number) {
  const utc = Date.UTC(y, m - 1, d + n);
  const dd = new Date(utc);
  return { y: dd.getUTCFullYear(), m: dd.getUTCMonth() + 1, d: dd.getUTCDate(), dow: dd.getUTCDay() };
}

function lastDayOfMonth(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function thisWeekTarget(y: number, m: number, d: number, dow: number, targetDow: number, nextWeek = false) {
  let delta = targetDow - dow;
  if (nextWeek) {
    if (delta <= 0) delta += 7;
    else delta += 7; // "다음 주 X" always next calendar week from ISO Monday perspective: add 7 then adjust
    // Simpler: go to next Monday then + offset
    const toMon = dow === 0 ? -6 : 1 - dow;
    const mon = addDays(y, m, d, toMon + 7);
    return addDays(mon.y, mon.m, mon.d, targetDow === 0 ? 6 : targetDow - 1);
  }
  if (delta < 0) delta += 7; // remaining day this week (or today if same)
  return addDays(y, m, d, delta);
}

function thisWeekRemaining(y: number, m: number, d: number, dow: number, targetDow: number) {
  let delta = targetDow - dow;
  if (delta < 0) delta += 7;
  return addDays(y, m, d, delta);
}

type TimeHit = { h: number; mi: number; precision: DatePrecision; matched: string; conf: number };

function parseTime(text: string): TimeHit | null {
  // 오후 3시 30분 / 오전 10시 / 오후 3시 반
  let m = text.match(/(오전|오후|AM|PM)\s*(\d{1,2})\s*시\s*(반|([0-5]?\d)\s*분)?/i);
  if (m) {
    let h = Number(m[2]);
    const mi = m[3] === "반" ? 30 : m[4] ? Number(m[4]) : 0;
    const ap = m[1].toLowerCase();
    if (ap === "오후" || ap === "pm") {
      if (h < 12) h += 12;
    } else if (ap === "오전" || ap === "am") {
      if (h === 12) h = 0;
    }
    return { h, mi, precision: "time", matched: m[0], conf: 0.95 };
  }
  m = text.match(/\b(\d{1,2}):([0-5]\d)\s*(AM|PM|오전|오후)?\b/i);
  if (m) {
    let h = Number(m[1]);
    const mi = Number(m[2]);
    const ap = (m[3] || "").toLowerCase();
    if (ap === "pm" || ap === "오후") {
      if (h < 12) h += 12;
    } else if (ap === "am" || ap === "오전") {
      if (h === 12) h = 0;
    } else if (!m[3] && h >= 1 && h <= 7) {
      // business heuristic: bare 1–7 → afternoon
      h += 12;
    }
    return { h, mi, precision: "time", matched: m[0], conf: 0.9 };
  }
  m = text.match(/(\d{1,2})\s*시\s*(반|([0-5]?\d)\s*분)?/);
  if (m) {
    let h = Number(m[1]);
    const mi = m[2] === "반" ? 30 : m[3] ? Number(m[3]) : 0;
    if (h >= 1 && h <= 7) h += 12; // heuristic
    else if (h === 12) {
      /* noon */
    }
    return { h, mi, precision: "time", matched: m[0], conf: 0.8 };
  }
  if (/점심\s*전/.test(text)) return { h: 12, mi: 0, precision: "part-of-day", matched: "점심 전", conf: 0.75 };
  if (/퇴근\s*전|EOD|오늘\s*중|금일\s*중|당일\s*중/i.test(text))
    return { h: 18, mi: 0, precision: "part-of-day", matched: "EOD/오늘 중", conf: 0.8 };
  if (/\bASAP\b|즉시|빨리/i.test(text)) return { h: 18, mi: 0, precision: "part-of-day", matched: "ASAP", conf: 0.6 };
  return null;
}

function roleOf(text: string, matchedAround: string): "due" | "start" | "unknown" {
  const idx = text.indexOf(matchedAround);
  const window = text.slice(Math.max(0, idx - 4), idx + matchedAround.length + 6);
  if (/까지|마감|데드라인|늦어도|중으로/.test(window) || /까지|마감/.test(text)) return "due";
  if (/부터|에\s*시작|시작/.test(window)) return "start";
  if (/에\b/.test(window) || /회의|미팅|콜/.test(text)) return "start";
  return "unknown";
}

/**
 * Find the best date/time expression in `text` relative to `anchorIso`.
 * Returns null if nothing useful found.
 */
export function normalizeKoreanDate(text: string, anchorIso: string | Date = new Date()): NormalizedDate | null {
  const a = toKstParts(anchorIso);
  const t = text.replace(/\s+/g, " ").trim();
  const time = parseTime(t);
  let y = a.y;
  let m = a.m;
  let d = a.d;
  let precision: DatePrecision = time ? time.precision : "date";
  let matched = "";
  let conf = 0.5;
  let found = false;

  // Relative day words
  let rm = t.match(/글피/);
  if (rm) {
    ({ y, m, d } = addDays(a.y, a.m, a.d, 3));
    matched = rm[0];
    conf = 0.95;
    found = true;
  } else if ((rm = t.match(/모레/))) {
    ({ y, m, d } = addDays(a.y, a.m, a.d, 2));
    matched = rm[0];
    conf = 0.95;
    found = true;
  } else if ((rm = t.match(/내일|명일/))) {
    ({ y, m, d } = addDays(a.y, a.m, a.d, 1));
    matched = rm[0];
    conf = 0.95;
    found = true;
  } else if ((rm = t.match(/오늘|금일|당일/))) {
    matched = rm[0];
    conf = 0.95;
    found = true;
  }

  // 이번 주 / 다음 주 / 차주 + weekday
  if (!found) {
    const wm = t.match(/(이번\s*주|다음\s*주|차주|금주)\s*([월화수목금토일])(?:요일)?/);
    if (wm) {
      const next = /다음|차주/.test(wm[1]);
      const target = DOW[wm[2]];
      const hit = next
        ? thisWeekTarget(a.y, a.m, a.d, a.dow, target, true)
        : thisWeekRemaining(a.y, a.m, a.d, a.dow, target);
      y = hit.y;
      m = hit.m;
      d = hit.d;
      matched = wm[0];
      conf = 0.9;
      found = true;
    }
  }

  // Bare weekday with 요일
  if (!found) {
    const wm = t.match(/([월화수목금토일])요일/);
    if (wm) {
      const hit = thisWeekRemaining(a.y, a.m, a.d, a.dow, DOW[wm[1]]);
      y = hit.y;
      m = hit.m;
      d = hit.d;
      matched = wm[0];
      conf = 0.75;
      found = true;
    }
  }

  // 이번 달 말 / 월말 / 다음 달 초
  if (!found) {
    if (/이번\s*달\s*말|월말/.test(t)) {
      d = lastDayOfMonth(a.y, a.m);
      matched = "월말";
      conf = 0.85;
      precision = "fuzzy";
      found = true;
    } else if (/다음\s*달\s*초/.test(t)) {
      const nm = a.m === 12 ? 1 : a.m + 1;
      const ny = a.m === 12 ? a.y + 1 : a.y;
      y = ny;
      m = nm;
      d = 1;
      matched = "다음 달 초";
      conf = 0.7;
      precision = "fuzzy";
      found = true;
    }
  }

  // Absolute: 2026-10-24 / 2026년 10월 24일 / 10/24 / 10.24 / 10월 24일 / 24일
  if (!found) {
    let am = t.match(/(20\d{2})[-\/.년]\s*(\d{1,2})[-\/.월]\s*(\d{1,2})일?/);
    if (am) {
      y = Number(am[1]);
      m = Number(am[2]);
      d = Number(am[3]);
      matched = am[0];
      conf = 0.95;
      found = true;
    } else if ((am = t.match(/(\d{1,2})\s*[\/.월]\s*(\d{1,2})일?/))) {
      m = Number(am[1]);
      d = Number(am[2]);
      y = a.y;
      // roll to next year if clearly past (>2 days ago)
      const candidate = Date.UTC(y, m - 1, d);
      const today = Date.UTC(a.y, a.m - 1, a.d);
      if (candidate < today - 2 * 86400000) y += 1;
      matched = am[0];
      conf = 0.85;
      found = true;
    } else if ((am = t.match(/(\d{1,2})일(?:\s*\(([월화수목금토일])\))?/))) {
      d = Number(am[1]);
      m = a.m;
      y = a.y;
      if (d < a.d - 1) {
        // next month
        if (m === 12) {
          m = 1;
          y += 1;
        } else m += 1;
      }
      if (am[2]) {
        const expect = DOW[am[2]];
        const actual = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        if (actual !== expect) conf = 0.55;
        else conf = 0.85;
      } else conf = 0.7;
      matched = am[0];
      found = true;
    }
  }

  // English Zoom-style: Oct 24, 2026
  if (!found) {
    const em = t.match(
      /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i,
    );
    if (em) {
      const months: Record<string, number> = {
        jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
      };
      m = months[em[1].slice(0, 3).toLowerCase()];
      d = Number(em[2]);
      y = Number(em[3]);
      matched = em[0];
      conf = 0.95;
      found = true;
    }
  }

  if (!found && !time) return null;
  if (!found) {
    // time-only → today (or tomorrow if time already passed? keep today; caller can adjust)
    matched = time!.matched;
    conf = time!.conf;
  } else if (time) {
    matched = `${matched} ${time.matched}`.trim();
    conf = Math.min(0.98, (conf + time.conf) / 2 + 0.1);
    precision = time.precision;
  } else {
    // date without time → default EOD 18:00 for due-like
    precision = precision === "fuzzy" ? "fuzzy" : "date";
  }

  const h = time ? time.h : 18;
  const mi = time ? time.mi : 0;
  const iso = formatKst(y, m, d, h, mi, 0);
  const role = roleOf(t, matched.split(" ")[0] || matched);
  return { iso, precision, role, confidence: conf, matched };
}

/** Extract all notable date hits (best-effort); used by tests & zoom combiner. */
export function normalizeAllDates(text: string, anchorIso: string | Date = new Date()): NormalizedDate[] {
  const one = normalizeKoreanDate(text, anchorIso);
  return one ? [one] : [];
}
