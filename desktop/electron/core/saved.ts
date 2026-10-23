import type { CacheFs } from "./search-cache";

/** Saved (bookmarked) messages. Client-local only: JSON in <userData>/saved/<userSeq>.json, never uploaded. */
export type SavedMessage = {
  id: string;
  roomKey: string;
  roomName: string;
  messageId?: number;
  message: string;
  sendUserName: string;
  createdAt?: string;
  savedAt: number;
};

export type SavedInput = Omit<SavedMessage, "id" | "savedAt">;

export const SAVED_MAX_ITEMS = 500;

export function savedMessageId(now = Date.now()): string {
  return `s${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Validate the renderer's save request; returns the fields to persist (id/savedAt are assigned by the store). */
export function normalizeSavedInput(raw: unknown): SavedInput {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const roomKey = str(o.roomKey).trim();
  if (!roomKey) throw new Error("대화방 정보가 없습니다");
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
  };
}

function parseSaved(text: string | null): SavedMessage[] {
  if (!text) return [];
  try {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    return list.filter(
      (x: unknown) =>
        x && typeof x === "object" &&
        typeof (x as SavedMessage).id === "string" &&
        typeof (x as SavedMessage).roomKey === "string" &&
        typeof (x as SavedMessage).message === "string",
    );
  } catch {
    return [];
  }
}

/** Per-account saved-message store; saves are debounced, flush() on quit/logout. */
export class SavedStore {
  private uid: number | null = null;
  private items: SavedMessage[] = [];
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

  /** Load (and cache) the list for the given account; switching accounts flushes the previous one. */
  for(uid: number | null | undefined): SavedMessage[] {
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
      /* no saved messages yet */
    }
    this.items = parseSaved(text);
    this.dirty = false;
    return this.items;
  }

  list(): SavedMessage[] {
    return this.items;
  }

  add(input: SavedInput, now = Date.now()): SavedMessage {
    if (this.uid == null) throw new Error("로그인이 필요합니다");
    const item: SavedMessage = { ...input, id: savedMessageId(now), savedAt: now };
    this.items = [item, ...this.items];
    const max = this.opts.maxItems ?? SAVED_MAX_ITEMS;
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
