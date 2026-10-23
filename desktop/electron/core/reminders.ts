import type { CacheFs } from "./search-cache";
import { tk } from "../../src/lib/i18n-core";

/** Message reminders ("나중에 알림"). Client-local only: JSON in <userData>/reminders/<userSeq>.json, never uploaded. */
export type ReminderPreset = "20m" | "1h" | "3h" | "tomorrow9" | "custom";

export const REMINDER_PRESETS: ReadonlyArray<{ id: ReminderPreset; label: string }> = [
  { id: "20m", label: tk("20분") },
  { id: "1h", label: tk("1시간") },
  { id: "3h", label: tk("3시간") },
  { id: "tomorrow9", label: tk("내일 오전 9시") },
  { id: "custom", label: tk("사용자 지정") },
];

export type Reminder = {
  id: string;
  roomKey: string;
  roomName: string;
  messageId?: number;
  message: string;
  sendUserName: string;
  createdAt?: string;
  dueAt: number;
  created: number;
};

export const REMINDER_MAX_ITEMS = 200;

export function reminderId(now = Date.now()): string {
  return `r${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeReminderPreset(value: unknown): ReminderPreset {
  if (value === "20m" || value === "1h" || value === "3h" || value === "tomorrow9" || value === "custom") return value;
  throw new Error("알림 시간을 선택하세요");
}

/** Next 09:00 local time (tomorrow morning, matching "내일 오전 9시"). */
export function nextNineAm(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 0, 0, 0).getTime();
}

export function presetDelayMs(preset: ReminderPreset, now: number): number {
  switch (preset) {
    case "20m":
      return 20 * 60_000;
    case "1h":
      return 60 * 60_000;
    case "3h":
      return 3 * 60 * 60_000;
    case "tomorrow9":
      return nextNineAm(now) - now;
    case "custom":
      throw new Error("사용자 지정 시간이 필요합니다");
  }
}

/** Absolute due timestamp for a preset (or an explicit customAt). Throws for past/invalid custom times. */
export function reminderDueAt(preset: ReminderPreset, now: number, customAt?: number): number {
  if (preset === "custom") {
    if (typeof customAt !== "number" || !Number.isFinite(customAt)) throw new Error("알림 시간을 지정하세요");
    if (customAt <= now) throw new Error("알림 시간은 미래여야 합니다");
    return customAt;
  }
  const due = now + presetDelayMs(preset, now);
  if (!Number.isFinite(due) || due <= now) throw new Error("알림 시간을 계산할 수 없습니다");
  return due;
}

/** Reminders whose time has come (used at startup to fire missed ones). */
export function dueReminders(list: Reminder[], now: number): Reminder[] {
  return list.filter((r) => r.dueAt <= now);
}

export function pendingReminders(list: Reminder[], now: number): Reminder[] {
  return list.filter((r) => r.dueAt > now);
}

/** Earliest future dueAt (for the main-process timer), or null when nothing is pending. */
export function nextDueAt(list: Reminder[], now: number): number | null {
  const future = pendingReminders(list, now).map((r) => r.dueAt);
  return future.length ? Math.min(...future) : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export type ReminderInput = Omit<Reminder, "id" | "dueAt" | "created"> & {
  preset: ReminderPreset;
  customAt?: number;
};

/** Validate the renderer's reminder request and compute dueAt. */
export function normalizeReminderInput(
  raw: unknown,
  now: number,
): Omit<Reminder, "id" | "dueAt" | "created"> & { dueAt: number } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const roomKey = str(o.roomKey).trim();
  if (!roomKey) throw new Error("대화방 정보가 없습니다");
  const preset = normalizeReminderPreset(o.preset);
  const customAt = typeof o.customAt === "number" ? o.customAt : undefined;
  const dueAt = reminderDueAt(preset, now, customAt);
  const messageId =
    typeof o.messageId === "number" && Number.isSafeInteger(o.messageId) && o.messageId > 0 ? o.messageId : undefined;
  const createdAt = str(o.createdAt);
  return {
    roomKey,
    roomName: str(o.roomName),
    message: str(o.message),
    sendUserName: str(o.sendUserName),
    messageId,
    createdAt: createdAt || undefined,
    dueAt,
  };
}

function parseReminders(text: string | null): Reminder[] {
  if (!text) return [];
  try {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    return list.filter(
      (x: unknown) =>
        x && typeof x === "object" &&
        typeof (x as Reminder).id === "string" &&
        typeof (x as Reminder).roomKey === "string" &&
        typeof (x as Reminder).dueAt === "number",
    );
  } catch {
    return [];
  }
}

/** Per-account reminder store; saves are debounced, flush() on quit/logout. */
export class ReminderStore {
  private uid: number | null = null;
  private items: Reminder[] = [];
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dir: string,
    private readonly fs: CacheFs,
    private readonly opts: { debounceMs?: number; join?: (...p: string[]) => string; maxItems?: number } = {}
  ) {}

  private file(uid: number) {
    const join = this.opts.join ?? ((...p: string[]) => p.join("/"));
    return join(this.dir, `${uid}.json`);
  }

  for(uid: number | null | undefined): Reminder[] {
    if (uid == null || !Number.isSafeInteger(uid) || uid <= 0) {
      this.uid = null;
      this.items = [];
      this.dirty = false;
      return this.items;
    }
    if (this.uid === uid) return this.items;
    this.flush();
    this.uid = uid;
    let text: string | null = null;
    try {
      text = this.fs.readFileSync(this.file(uid), "utf8");
    } catch {
      /* no reminders yet */
    }
    this.items = parseReminders(text);
    this.dirty = false;
    return this.items;
  }

  list(): Reminder[] {
    return this.items;
  }

  add(input: Omit<Reminder, "id" | "dueAt" | "created"> & { dueAt: number }, now = Date.now()): Reminder {
    if (this.uid == null) throw new Error("로그인이 필요합니다");
    const item: Reminder = { ...input, id: reminderId(now), created: now };
    this.items = [item, ...this.items];
    const max = this.opts.maxItems ?? REMINDER_MAX_ITEMS;
    if (this.items.length > max) this.items.length = max;
    this.dirty = true;
    this.scheduleSave();
    return item;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length === before) return false;
    this.dirty = true;
    this.scheduleSave();
    return true;
  }

  /** Remove every reminder that is due (fired); returns how many were removed. */
  removeDue(now: number): number {
    const due = new Set(dueReminders(this.items, now).map((r) => r.id));
    if (!due.size) return 0;
    this.items = this.items.filter((i) => !due.has(i.id));
    this.dirty = true;
    this.scheduleSave();
    return due.size;
  }

  scheduleSave() {
    if (!this.dirty || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.opts.debounceMs ?? 3000);
    (this.timer as any)?.unref?.();
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty || this.uid == null) return;
    const f = this.file(this.uid);
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
      this.fs.writeFileSync(f + ".tmp", JSON.stringify(this.items), { mode: 0o600 });
      this.fs.renameSync(f + ".tmp", f);
      this.dirty = false;
    } catch {
      /* local cache only; retry on next change */
    }
  }

  clear() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.items = [];
    this.dirty = false;
    try {
      this.fs.rmSync(this.dir, { force: true, recursive: true });
    } catch {
      /* ignore */
    }
  }
}
