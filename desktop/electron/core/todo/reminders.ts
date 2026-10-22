/**
 * Overdue + Zoom reminder scheduler helpers (pure time logic).
 * Actual Notification + shell.openExternal live in main.
 */
import type { TodoItem, TodoSettings } from "./types";

export type ReminderAction =
  | { kind: "overdue"; todoId: string; stage: 1 | 2 | 3; title: string; body: string }
  | { kind: "zoom"; todoId: string; minutesBefore: number; title: string; body: string; join: true };

export function inWorkHours(now: Date, settings: TodoSettings, timeZone = "Asia/Seoul"): boolean {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false });
  let h = Number(fmt.format(now));
  if (h === 24) h = 0;
  return h >= settings.workStartHour && h < settings.workEndHour;
}

export function bossCopy(stage: 1 | 2 | 3, title: string, polite: boolean): { title: string; body: string } {
  if (polite) {
    if (stage === 1) return { title: "할일 마감 임박", body: `「${title}」 마감 1시간 전입니다.` };
    if (stage === 2) return { title: "할일 마감", body: `「${title}」 마감 시각입니다.` };
    return { title: "미완료 할일", body: `「${title}」 아직 완료되지 않았습니다.` };
  }
  if (stage === 1) return { title: "슬슬 마감이에요~", body: `「${title}」 한 시간 남았어요.` };
  if (stage === 2) return { title: "마감 지났어요!", body: `「${title}」 지금이 마감이에요.` };
  return { title: "아직도요?!", body: `「${title}」 미완료예요. 처리해 주세요.` };
}

/**
 * Decide which reminders should fire at `now`.
 * Caller tracks fired keys to avoid dupes within the tick.
 */
export function planReminders(
  items: TodoItem[],
  settings: TodoSettings,
  now = new Date(),
  opts?: { inMeeting?: boolean },
): ReminderAction[] {
  if (!settings.remindersEnabled) return [];
  if (opts?.inMeeting && settings.quietDuringMeetings) return [];
  const quiet = !inWorkHours(now, settings);
  const out: ReminderAction[] = [];

  for (const it of items) {
    if (it.status !== "open") continue;

    // Zoom upcoming
    if (it.type === "meeting" && (it.start || it.due)) {
      const start = new Date(it.start || it.due!).getTime();
      const mins = (start - now.getTime()) / 60000;
      for (const m of settings.zoomNotifyMinutes) {
        if (mins <= m && mins > m - 0.75) {
          out.push({
            kind: "zoom",
            todoId: it.id,
            minutesBefore: m,
            title: m <= 1 ? "곧 Zoom 시작" : `${m}분 후 Zoom`,
            body: it.title,
            join: true,
          });
        }
      }
    }

    if (!it.due) continue;
    if (quiet) continue; // overdue quiet outside work hours

    const due = new Date(it.due).getTime();
    const ms = now.getTime() - due;
    const stage = it.overdueStage || 0;

    // 1h before
    if (stage < 1 && due - now.getTime() <= 3600000 && due - now.getTime() > 0) {
      const c = bossCopy(1, it.title, settings.politeMode);
      out.push({ kind: "overdue", todoId: it.id, stage: 1, ...c });
      continue;
    }
    // at due (within 2 min window)
    if (stage < 2 && ms >= 0 && ms < 120000) {
      const c = bossCopy(2, it.title, settings.politeMode);
      out.push({ kind: "overdue", todoId: it.id, stage: 2, ...c });
      continue;
    }
    // daily after due, max stage 3
    if (ms > 0 && stage < 3) {
      const last = it.lastOverdueAt ? new Date(it.lastOverdueAt).getTime() : 0;
      if (now.getTime() - last >= 20 * 3600000) {
        // ~once a day; also prefer morning ~09:30 — approximate by work start hour
        const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", hour12: false });
        const h = Number(fmt.format(now));
        if (h >= settings.workStartHour && h < settings.workStartHour + 2) {
          const c = bossCopy(3, it.title, settings.politeMode);
          out.push({ kind: "overdue", todoId: it.id, stage: 3, ...c });
        }
      }
    }
  }
  return out;
}

export function bossIconPath(stage: 1 | 2 | 3, resourcesDir: string): string {
  const map = { 1: "tone1.jpg", 2: "tone2.jpg", 3: "tone3.jpg" } as const;
  return `${resourcesDir}/boss/${map[stage]}`;
}
