import type { CacheFs } from "./search-cache";
import { apiRoomSeq, checkForwardTarget } from "./forward";
import type { Room } from "./types";

/**
 * 예약 전송 (scheduled send). Client-local only: JSON in <userData>/scheduled/<userSeq>.json, never uploaded.
 * The main process arms a timer; when it fires the app runs the normal send path (core.sendText).
 * On startup, items missed while the app was closed are NOT auto-sent unless the per-item option
 * "놓친 경우 앱 실행 시 전송" (sendOnMissedLaunch) is set; otherwise they are marked "missed" for the
 * user to send or cancel. The self-only guard (UBM_SELF_ONLY) applies at send time.
 */

export type ScheduledState = "scheduled" | "missed";

export type ScheduledMessage = {
  id: string;
  roomKey: string;
  roomName: string;
  text: string;
  sendAt: number;
  /** 놓친 경우 앱 실행 시 전송 */
  sendOnMissedLaunch: boolean;
  state: ScheduledState;
  created: number;
};

export const SCHEDULED_MAX_ITEMS = 200;
export const SCHEDULED_MAX_LENGTH = 4000;

export function scheduledId(now = Date.now()): string {
  return `s${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export type ScheduledInput = {
  roomKey: string;
  roomName?: string;
  text: string;
  sendAt: number;
  sendOnMissedLaunch?: boolean;
};

/** Validate the renderer's schedule request and compute nothing but a validated record. */
export function normalizeScheduledInput(
  raw: unknown,
  now: number,
): Omit<ScheduledMessage, "id" | "state" | "created"> {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const roomKey = str(o.roomKey).trim();
  if (!roomKey) throw new Error("대화방 정보가 없습니다");
  const text = str(o.text).trim();
  if (!text) throw new Error("예약할 메시지를 입력하세요");
  if (text.length > SCHEDULED_MAX_LENGTH) throw new Error(`메시지는 ${SCHEDULED_MAX_LENGTH}자까지 예약할 수 있습니다`);
  const sendAt = typeof o.sendAt === "number" ? o.sendAt : Number.NaN;
  if (!Number.isFinite(sendAt) || sendAt <= now) throw new Error("예약 시간은 미래여야 합니다");
  return {
    roomKey,
    roomName: str(o.roomName),
    text,
    sendAt,
    sendOnMissedLaunch: o.sendOnMissedLaunch === true,
  };
}

/** Scheduled items whose time has come (still waiting to be sent). Missed items are excluded. */
export function dueScheduled(list: ScheduledMessage[], now: number): ScheduledMessage[] {
  return list.filter((s) => s.state === "scheduled" && s.sendAt <= now);
}

export function pendingScheduled(list: ScheduledMessage[], now: number): ScheduledMessage[] {
  return list.filter((s) => s.state === "scheduled" && s.sendAt > now);
}

/** Items that were missed while the app was closed (awaiting the user to send/cancel). */
export function missedScheduled(list: ScheduledMessage[]): ScheduledMessage[] {
  return list.filter((s) => s.state === "missed");
}

/** Earliest future sendAt (for the main-process timer), or null when nothing is pending. */
export function nextScheduledAt(list: ScheduledMessage[], now: number): number | null {
  const future = pendingScheduled(list, now).map((s) => s.sendAt);
  return future.length ? Math.min(...future) : null;
}

/**
 * Self-only guard applied at scheduled-send time (reuses checkForwardTarget).
 * Resolves the room's API seq (buddy rooms map to their buddyRoomSeq) and throws when the
 * target is not the self room in safe mode.
 */
export function guardScheduledTarget({
  selfOnly,
  me,
  selfRoomSeq,
  room,
}: {
  selfOnly: boolean;
  me: number;
  selfRoomSeq?: number | null;
  room: Pick<Room, "kind" | "seq" | "buddyRoomSeq"> | null;
}): void {
  if (!room) throw new Error("알 수 없는 대화방입니다");
  const roomSeq = apiRoomSeq(room);
  checkForwardTarget({ selfOnly, target: { roomSeq }, me, selfRoomSeq });
}

function parseScheduled(text: string | null): ScheduledMessage[] {
  if (!text) return [];
  try {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    return list.filter(
      (x: unknown) =>
        x && typeof x === "object" &&
        typeof (x as ScheduledMessage).id === "string" &&
        typeof (x as ScheduledMessage).roomKey === "string" &&
        typeof (x as ScheduledMessage).sendAt === "number" &&
        ((x as ScheduledMessage).state === "scheduled" || (x as ScheduledMessage).state === "missed"),
    );
  } catch {
    return [];
  }
}

/** Per-account scheduled queue; saves are debounced, flush() on quit/logout. */
export class ScheduledStore {
  private uid: number | null = null;
  private items: ScheduledMessage[] = [];
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

  for(uid: number | null | undefined): ScheduledMessage[] {
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
      /* no scheduled yet */
    }
    this.items = parseScheduled(text);
    this.dirty = false;
    return this.items;
  }

  list(): ScheduledMessage[] {
    return this.items;
  }

  add(input: Omit<ScheduledMessage, "id" | "state" | "created">, now = Date.now()): ScheduledMessage {
    if (this.uid == null) throw new Error("로그인이 필요합니다");
    const item: ScheduledMessage = { ...input, id: scheduledId(now), state: "scheduled", created: now };
    this.items = [item, ...this.items];
    const max = this.opts.maxItems ?? SCHEDULED_MAX_ITEMS;
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

  /** Mark an item missed (past-due while the app was closed and not auto-sent). Returns true on change. */
  markMissed(id: string): boolean {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.state === "missed") return false;
    item.state = "missed";
    this.dirty = true;
    this.scheduleSave();
    return true;
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
}
