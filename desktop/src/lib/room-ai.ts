/**
 * 암묵적 방 AI (1.1 alpha). Summary + todo extraction stay out of the chat transcript.
 *
 * The desktop never holds a MiniMax key. This module is the provider seam: the alpha ships a
 * deterministic stub so the panel works offline. A later company proxy (bot.ubion.global style)
 * should accept the same RoomAiProvider calls and keep the key server-side.
 *
 * Suggested proxy shape (not called from here):
 *   POST {UBM_BOT_API_URL}/v1/room-ai/run
 *   headers: X-UBM-User-Seq, X-UBM-Session   (never DaouOffice cookies)
 *   body: { roomKey, messages: [{ sender, text, createdAt }] }
 *   200: { summary: string, todos: [{ title, assignee?, due? }] }
 */

export const ROOM_AI_STORAGE_KEY = "ubm.room-ai.v1";
export const ROOM_AI_MESSAGE_LIMIT = 200;
export const ROOM_AI_ROOM_LIMIT = 200;
export const ROOM_AI_TODO_LIMIT = 30;
/** Foreground refresh while a room stays open. Does not run when the window is hidden or unfocused. */
export const ROOM_AI_POLL_MS = 3 * 60_000;

export type RoomAiMessage = {
  id?: number;
  sender?: string;
  text: string;
  createdAt?: string;
};

export type RoomAiSource = {
  messageId?: number;
  sendUserName?: string;
  message?: string;
  text?: string;
  createdAt?: string;
  deleted?: boolean;
  pending?: boolean;
  failed?: boolean;
};

export type RoomAiTodoDraft = {
  title: string;
  assignee?: string;
  due?: string;
};

export type RoomAiTodo = RoomAiTodoDraft & {
  id: string;
  done: boolean;
};

export type RoomAiRecord = {
  summary: string;
  todos: RoomAiTodo[];
  updatedAt: number;
  fingerprint: string;
};

export type RoomAiRunReason = "open" | "timer" | "refresh";

export interface RoomAiProvider {
  summarize(roomMessages: RoomAiMessage[]): Promise<string>;
  extractTodos(roomMessages: RoomAiMessage[]): Promise<RoomAiTodoDraft[]>;
}

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

type StoreFile = {
  version: 1;
  byUser: Record<string, Record<string, RoomAiRecord>>;
};

const STUB_LEADS = [
  "최근 대화는 진행 상황 공유와 후속 확인이 중심입니다.",
  "참여자들이 일정과 담당을 조율하는 흐름입니다.",
  "요청과 확인이 필요한 항목이 함께 있습니다.",
] as const;

const STUB_TODO_PAIRS: readonly (readonly [string, string])[] = [
  ["요청 사항 확인하기", "담당자에게 진행 여부 회신하기"],
  ["일정 조율하기", "회의 후속 정리하기"],
  ["공유된 자료 검토하기", "다음 액션 확정하기"],
];

const TASK_HINT = /해주세요|부탁|할\s*일|확인\s*부탁|TODO|todo|까지/;

function fnv32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  if (chars.length <= max) return chars.join("");
  return `${chars.slice(0, max).join("")}…`;
}

function userKey(userId: number): string | null {
  return Number.isSafeInteger(userId) && userId > 0 ? String(userId) : null;
}

/** Text rows the provider may see: skip tombstones and unsent bubbles, keep the newest window. */
export function toRoomAiMessages(messages: readonly RoomAiSource[], limit = ROOM_AI_MESSAGE_LIMIT): RoomAiMessage[] {
  const out: RoomAiMessage[] = [];
  for (const m of messages) {
    if (!m || m.deleted || m.pending || m.failed) continue;
    const text = (m.message ?? m.text ?? "").trim();
    if (!text) continue;
    const sender = (m.sendUserName ?? "").trim();
    out.push({
      id: typeof m.messageId === "number" ? m.messageId : undefined,
      sender: sender || undefined,
      text,
      createdAt: m.createdAt,
    });
  }
  return out.length > limit ? out.slice(out.length - limit) : out;
}

export function roomAiFingerprint(messages: readonly RoomAiMessage[]): string {
  const body = messages.map((m) => `${m.id ?? ""}|${m.sender ?? ""}|${m.text}`).join("\u0001");
  return `${messages.length}:${fnv32(body).toString(16)}`;
}

/**
 * Foreground gate. Refresh, open, and the timer all refuse to call the provider when the window
 * is unfocused or hidden. Open/timer also skip when the loaded transcript has not changed.
 */
export function roomAiShouldRun(opts: {
  reason: RoomAiRunReason;
  focused: boolean;
  hidden: boolean;
  fingerprint: string;
  savedFingerprint?: string;
}): boolean {
  if (!opts.focused || opts.hidden) return false;
  if (opts.reason === "refresh") return true;
  return opts.fingerprint !== (opts.savedFingerprint ?? "");
}

export function stubSummarize(messages: readonly RoomAiMessage[]): string {
  if (!messages.length) return "[스텁] 요약할 대화가 없습니다.";
  const people = [...new Set(messages.map((m) => m.sender).filter((s): s is string => !!s))];
  const who = people.length ? people.slice(0, 3).join(", ") : "참여자";
  const last = clip(messages[messages.length - 1].text, 40);
  const lead = STUB_LEADS[fnv32(messages.map((m) => m.text).join("\n")) % STUB_LEADS.length];
  return `[스텁] ${lead} 메시지 ${messages.length}건 · ${who}. 최근 발화: “${last}”`;
}

export function stubExtractTodos(messages: readonly RoomAiMessage[]): RoomAiTodoDraft[] {
  if (!messages.length) return [];
  const drafts: RoomAiTodoDraft[] = [];
  const seen = new Set<string>();
  const push = (draft: RoomAiTodoDraft) => {
    const title = clip(draft.title, 60);
    if (!title || seen.has(title)) return;
    seen.add(title);
    drafts.push({ title, assignee: draft.assignee?.trim() || undefined, due: draft.due?.trim() || undefined });
  };
  for (const m of messages) {
    if (!TASK_HINT.test(m.text)) continue;
    push({ title: m.text, assignee: m.sender });
    if (drafts.length >= 2) break;
  }
  const pair = STUB_TODO_PAIRS[fnv32(messages.map((m) => m.text).join("\n")) % STUB_TODO_PAIRS.length];
  const assignee = messages.find((m) => m.sender)?.sender;
  for (let i = 0; i < pair.length && drafts.length < 3; i++) push({ title: pair[i], assignee: i === 0 ? assignee : undefined });
  return drafts;
}

export function roomAiTodoId(title: string, assignee?: string): string {
  return `t${fnv32(`${title}|${assignee ?? ""}`).toString(16)}`;
}

/** Keep a locally checked todo checked when the same title is extracted again. */
export function mergeRoomAiTodos(prev: readonly RoomAiTodo[], drafts: readonly RoomAiTodoDraft[]): RoomAiTodo[] {
  const done = new Map(prev.map((t) => [t.id, t.done]));
  const out: RoomAiTodo[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    const title = draft.title.trim();
    if (!title) continue;
    const id = roomAiTodoId(title, draft.assignee);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title,
      assignee: draft.assignee?.trim() || undefined,
      due: draft.due?.trim() || undefined,
      done: done.get(id) ?? false,
    });
    if (out.length >= ROOM_AI_TODO_LIMIT) break;
  }
  return out;
}

export class StubRoomAiProvider implements RoomAiProvider {
  constructor(private readonly opts: { delayMs?: number } = {}) {}

  private async wait(): Promise<void> {
    const ms = this.opts.delayMs ?? (import.meta.env.VITEST ? 0 : 320);
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async summarize(roomMessages: RoomAiMessage[]): Promise<string> {
    await this.wait();
    return stubSummarize(roomMessages);
  }

  async extractTodos(roomMessages: RoomAiMessage[]): Promise<RoomAiTodoDraft[]> {
    await this.wait();
    return stubExtractTodos(roomMessages);
  }
}

export class RoomAiService {
  constructor(private readonly provider: RoomAiProvider) {}

  async run(roomMessages: RoomAiMessage[]): Promise<{ summary: string; todos: RoomAiTodoDraft[] }> {
    const [summary, todos] = await Promise.all([
      this.provider.summarize(roomMessages),
      this.provider.extractTodos(roomMessages),
    ]);
    return { summary: summary.trim(), todos };
  }
}

function emptyStore(): StoreFile {
  return { version: 1, byUser: {} };
}

function readStore(storage: StorageLike): StoreFile {
  try {
    const raw = storage.getItem(ROOM_AI_STORAGE_KEY);
    if (!raw) return emptyStore();
    const data = JSON.parse(raw) as Partial<StoreFile>;
    if (!data || data.version !== 1 || !data.byUser || typeof data.byUser !== "object") return emptyStore();
    return { version: 1, byUser: data.byUser };
  } catch {
    return emptyStore();
  }
}

function writeStore(storage: StorageLike, file: StoreFile): void {
  try {
    storage.setItem(ROOM_AI_STORAGE_KEY, JSON.stringify(file));
  } catch {
    /* local cache only */
  }
}

function isRecord(value: unknown): value is RoomAiRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as RoomAiRecord;
  return typeof r.summary === "string" && typeof r.fingerprint === "string" && typeof r.updatedAt === "number" && Array.isArray(r.todos);
}

function sanitize(record: RoomAiRecord): RoomAiRecord {
  const todos: RoomAiTodo[] = [];
  for (const todo of record.todos) {
    if (!todo || typeof todo.id !== "string" || typeof todo.title !== "string") continue;
    todos.push({
      id: todo.id,
      title: todo.title,
      assignee: typeof todo.assignee === "string" && todo.assignee ? todo.assignee : undefined,
      due: typeof todo.due === "string" && todo.due ? todo.due : undefined,
      done: todo.done === true,
    });
  }
  return { summary: record.summary, fingerprint: record.fingerprint, updatedAt: record.updatedAt, todos };
}

export function loadRoomAi(storage: StorageLike, userId: number, roomKey: string): RoomAiRecord | null {
  const uid = userKey(userId);
  if (!uid || !roomKey) return null;
  const record = readStore(storage).byUser[uid]?.[roomKey];
  return isRecord(record) ? sanitize(record) : null;
}

export function saveRoomAi(storage: StorageLike, userId: number, roomKey: string, record: RoomAiRecord): void {
  const uid = userKey(userId);
  if (!uid || !roomKey) return;
  const file = readStore(storage);
  const rooms = { ...(file.byUser[uid] ?? {}), [roomKey]: record };
  const keys = Object.keys(rooms);
  if (keys.length > ROOM_AI_ROOM_LIMIT) {
    keys
      .sort((a, b) => (rooms[a]?.updatedAt ?? 0) - (rooms[b]?.updatedAt ?? 0))
      .slice(0, keys.length - ROOM_AI_ROOM_LIMIT)
      .forEach((k) => { delete rooms[k]; });
  }
  file.byUser[uid] = rooms;
  writeStore(storage, file);
}

export function toggleRoomAiTodo(storage: StorageLike, userId: number, roomKey: string, todoId: string): RoomAiRecord | null {
  const current = loadRoomAi(storage, userId, roomKey);
  if (!current) return null;
  let changed = false;
  const todos = current.todos.map((todo) => {
    if (todo.id !== todoId) return todo;
    changed = true;
    return { ...todo, done: !todo.done };
  });
  if (!changed) return current;
  const next = { ...current, todos };
  saveRoomAi(storage, userId, roomKey, next);
  return next;
}
