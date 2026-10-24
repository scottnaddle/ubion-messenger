/**
 * 암묵적 방 AI (1.1 alpha). Summary + todo extraction stay out of the chat transcript.
 *
 * The desktop never holds a MiniMax key. Scott's alpha talks to a local proxy that keeps the key:
 *   POST http://127.0.0.1:8787/v1/room-ai/run
 *   body: { roomKey, messages: [{ id, sender, text, createdAt }] }
 *   200: { summary, todos: [{ title, assignee?, due?, sourceMessageIds?: (string|number)[] }] }
 * Override the URL with VITE_UBM_ROOM_AI_URL. VITE_UBM_ROOM_AI_STUB=1 forces the offline stub.
 * A network or 5xx failure is shown in the panel. It does not silently switch to the stub.
 */

export const ROOM_AI_STORAGE_KEY = "ubm.room-ai.v1";
export const ROOM_AI_MESSAGE_LIMIT = 200;
export const ROOM_AI_ROOM_LIMIT = 200;
export const ROOM_AI_TODO_LIMIT = 30;
/** Foreground refresh while a room stays open. Does not run when the window is hidden or unfocused. */
export const ROOM_AI_POLL_MS = 3 * 60_000;
/** Scott-only alpha. The MiniMax key stays on this local proxy, never in the app. */
export const UBM_ROOM_AI_URL = "http://127.0.0.1:8787/v1/room-ai/run";
export const ROOM_AI_LIVE_ERROR = "방 AI 서버에 연결하지 못했습니다.";
export const ROOM_AI_SERVER_ERROR = "방 AI 서버가 응답하지 못했습니다.";
export const ROOM_AI_LIVE_BAD = "방 AI 응답을 확인하지 못했습니다.";

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
  /** Message ids in the window this item was synthesized from. Numbers or decimal strings. */
  sourceMessageIds?: (number | string)[];
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
  summarize(roomMessages: RoomAiMessage[], roomKey?: string): Promise<string>;
  extractTodos(roomMessages: RoomAiMessage[], roomKey?: string): Promise<RoomAiTodoDraft[]>;
}

export type RoomAiEnv = {
  VITE_UBM_ROOM_AI_URL?: string;
  VITE_UBM_ROOM_AI_STUB?: string;
  VITEST?: boolean | string;
};

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

type StoreFile = {
  version: 1;
  byUser: Record<string, Record<string, RoomAiRecord>>;
};

const STUB_THEMES: readonly { label: string; test: RegExp }[] = [
  { label: "검토·자료", test: /검토|자료|공유/ },
  { label: "회신", test: /회신|답장|답변/ },
  { label: "일정", test: /일정|회의|미팅/ },
  { label: "확인 요청", test: /부탁|해주세요|확인/ },
];

const STUB_ACTIONS: readonly { title: string; test: RegExp }[] = [
  { title: "자료 검토하기", test: /검토|자료|공유/ },
  { title: "회신하기", test: /회신|답장|답변/ },
  { title: "일정 맞추기", test: /일정|회의|미팅/ },
  { title: "확인 요청 처리하기", test: /부탁|해주세요|확인|할\s*일|TODO|todo/ },
];

function fnv32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
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

/** Clock label taken from the ISO string itself, so the stub does not depend on the host timezone. */
function stampLabel(iso?: string): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  if (!m) return null;
  return `${Number(m[2])}/${Number(m[3])} ${m[4]}:${m[5]}`;
}

function spanLabel(messages: readonly RoomAiMessage[]): string {
  const stamps = messages
    .map((m) => m.createdAt)
    .filter((iso): iso is string => !!iso && stampLabel(iso) != null)
    .sort();
  if (!stamps.length) return "";
  const start = stampLabel(stamps[0]);
  const end = stampLabel(stamps[stamps.length - 1]);
  if (!start || !end || start === end) return start ?? "";
  return `${start}–${end}`;
}

function dueFrom(text: string): string | undefined {
  if (/내일/.test(text)) return "내일";
  if (/오늘/.test(text)) return "오늘";
  const m = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(text);
  if (m) return `${m[1]}/${m[2]}`;
  if (/까지/.test(text)) return "기한 있음";
  return undefined;
}

/** Keep numeric ids as numbers and decimal strings as strings. Both match a chat messageId via String(). */
export function normalizeSourceMessageIds(ids: readonly unknown[] | undefined): (number | string)[] {
  const out: (number | string)[] = [];
  const seen = new Set<string>();
  for (const id of ids ?? []) {
    let key: string | null = null;
    let value: number | string | null = null;
    if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
      key = String(id);
      value = id;
    } else if (typeof id === "string" && /^[1-9]\d*$/.test(id.trim())) {
      key = String(Number(id.trim()));
      value = key;
    }
    if (!key || value == null || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function sourceIds(ids: readonly unknown[] | undefined): (number | string)[] {
  return normalizeSourceMessageIds(ids);
}

/**
 * Room-level synthesis. The header names how many messages were in the window and their time span.
 * Bullets describe themes across that window. They do not quote message text.
 */
export function stubSummarize(messages: readonly RoomAiMessage[]): string {
  if (!messages.length) return "[스텁] 요약할 대화가 없습니다.";
  const span = spanLabel(messages);
  const people = [...new Set(messages.map((m) => m.sender).filter((s): s is string => !!s))];
  const who = people.length ? people.slice(0, 4).join(", ") : "이름 없음";
  const lines = [
    `[스텁] 메시지 ${messages.length}건${span ? ` · ${span}` : ""}`,
    `• 참여자 ${people.length || 0}명: ${who}`,
  ];
  let themed = 0;
  for (const theme of STUB_THEMES) {
    const n = messages.filter((m) => theme.test.test(m.text)).length;
    if (!n) continue;
    themed += n;
    lines.push(`• ${theme.label} 관련 발화 ${n}건`);
  }
  if (!themed) lines.push(`• 요청으로 보이는 키워드는 없고, 일반 대화 ${messages.length}건입니다.`);
  return lines.join("\n");
}

/** One structured todo per action found anywhere in the window, with the source message ids. */
export function stubExtractTodos(messages: readonly RoomAiMessage[]): RoomAiTodoDraft[] {
  if (!messages.length) return [];
  const buckets = new Map<string, { title: string; ids: number[]; assignee?: string; due?: string }>();
  for (const message of messages) {
    const action = STUB_ACTIONS.find((item) => item.test.test(message.text));
    if (!action) continue;
    let bucket = buckets.get(action.title);
    if (!bucket) {
      bucket = { title: action.title, ids: [], assignee: message.sender, due: dueFrom(message.text) };
      buckets.set(action.title, bucket);
    }
    if (typeof message.id === "number") bucket.ids.push(message.id);
    if (!bucket.due) bucket.due = dueFrom(message.text);
    if (!bucket.assignee && message.sender) bucket.assignee = message.sender;
  }
  return [...buckets.values()].slice(0, 5).map((bucket) => ({
    title: bucket.title,
    assignee: bucket.assignee,
    due: bucket.due,
    sourceMessageIds: sourceIds(bucket.ids),
  }));
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
    const assignee = draft.assignee?.trim() || undefined;
    const due = draft.due?.trim() || undefined;
    const ids = sourceIds(draft.sourceMessageIds ?? []);
    out.push({
      id,
      title,
      done: done.get(id) ?? false,
      ...(assignee ? { assignee } : {}),
      ...(due ? { due } : {}),
      ...(ids.length ? { sourceMessageIds: ids } : {}),
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

  async run(roomKey: string, roomMessages: RoomAiMessage[]): Promise<{ summary: string; todos: RoomAiTodoDraft[] }> {
    const [summary, todos] = await Promise.all([
      this.provider.summarize(roomMessages, roomKey),
      this.provider.extractTodos(roomMessages, roomKey),
    ]);
    return { summary: summary.trim(), todos };
  }
}

/** Null means "use the stub" (explicit stub flag, or the vitest runner). Otherwise the live proxy URL. */
export function resolveRoomAiUrl(env: RoomAiEnv | undefined): string | null {
  if (!env) return UBM_ROOM_AI_URL;
  if (env.VITE_UBM_ROOM_AI_STUB === "1" || env.VITEST === true || env.VITEST === "true") return null;
  const custom = typeof env.VITE_UBM_ROOM_AI_URL === "string" ? env.VITE_UBM_ROOM_AI_URL.trim() : "";
  return custom || UBM_ROOM_AI_URL;
}

function roomAiEnvFromBuild(): RoomAiEnv {
  return {
    VITE_UBM_ROOM_AI_URL: import.meta.env.VITE_UBM_ROOM_AI_URL,
    VITE_UBM_ROOM_AI_STUB: import.meta.env.VITE_UBM_ROOM_AI_STUB,
    VITEST: import.meta.env.VITEST,
  };
}

export function createRoomAiService(env: RoomAiEnv = roomAiEnvFromBuild()): RoomAiService {
  const url = resolveRoomAiUrl(env);
  if (!url) return new RoomAiService(new StubRoomAiProvider());
  return new RoomAiService(new HttpRoomAiProvider({ url }));
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function parseRoomAiResponse(data: unknown): { summary: string; todos: RoomAiTodoDraft[] } {
  if (!data || typeof data !== "object") throw new Error(ROOM_AI_LIVE_BAD);
  const summary = (data as { summary?: unknown }).summary;
  if (typeof summary !== "string" || !summary.trim()) throw new Error(ROOM_AI_LIVE_BAD);
  const rawTodos = (data as { todos?: unknown }).todos;
  if (rawTodos != null && !Array.isArray(rawTodos)) throw new Error(ROOM_AI_LIVE_BAD);
  const todos: RoomAiTodoDraft[] = [];
  for (const item of rawTodos ?? []) {
    if (!item || typeof item !== "object") continue;
    const title = (item as { title?: unknown }).title;
    if (typeof title !== "string" || !title.trim()) continue;
    const assignee = (item as { assignee?: unknown }).assignee;
    const due = (item as { due?: unknown }).due;
    const sourceMessageIds = (item as { sourceMessageIds?: unknown }).sourceMessageIds;
    const ids = normalizeSourceMessageIds(Array.isArray(sourceMessageIds) ? sourceMessageIds : []);
    todos.push({
      title: title.trim(),
      ...(typeof assignee === "string" && assignee.trim() ? { assignee: assignee.trim() } : {}),
      ...(typeof due === "string" && due.trim() ? { due: due.trim() } : {}),
      ...(ids.length ? { sourceMessageIds: ids } : {}),
    });
  }
  return { summary: summary.trim(), todos };
}

/**
 * One POST per transcript. summarize and extractTodos share that response.
 * Failures throw a short Korean Error. Callers must not replace them with the stub.
 */
export class HttpRoomAiProvider implements RoomAiProvider {
  private readonly pending = new Map<string, Promise<{ summary: string; todos: RoomAiTodoDraft[] }>>();

  constructor(private readonly opts: { url?: string; fetchImpl?: FetchLike; timeoutMs?: number } = {}) {}

  private endpoint(): string {
    return (this.opts.url || UBM_ROOM_AI_URL).trim();
  }

  private load(roomKey: string, messages: RoomAiMessage[]): Promise<{ summary: string; todos: RoomAiTodoDraft[] }> {
    const key = `${roomKey}\n${roomAiFingerprint(messages)}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const job = this.post(roomKey, messages).finally(() => {
      if (this.pending.get(key) === job) this.pending.delete(key);
    });
    this.pending.set(key, job);
    return job;
  }

  async summarize(roomMessages: RoomAiMessage[], roomKey = ""): Promise<string> {
    return (await this.load(roomKey, roomMessages)).summary;
  }

  async extractTodos(roomMessages: RoomAiMessage[], roomKey = ""): Promise<RoomAiTodoDraft[]> {
    return (await this.load(roomKey, roomMessages)).todos;
  }

  private async post(roomKey: string, messages: RoomAiMessage[]): Promise<{ summary: string; todos: RoomAiTodoDraft[] }> {
    const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const timeoutMs = this.opts.timeoutMs ?? 45_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetchImpl(this.endpoint(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            roomKey,
            messages: messages.map((m) => ({
              id: m.id,
              sender: m.sender ?? "",
              text: m.text,
              createdAt: m.createdAt,
            })),
          }),
          signal: controller.signal,
        });
      } catch {
        throw new Error(ROOM_AI_LIVE_ERROR);
      }
      if (res.status >= 500) throw new Error(ROOM_AI_SERVER_ERROR);
      if (!res.ok) throw new Error(ROOM_AI_LIVE_BAD);
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        throw new Error(ROOM_AI_LIVE_BAD);
      }
      return parseRoomAiResponse(data);
    } finally {
      clearTimeout(timer);
    }
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
    const assignee = typeof todo.assignee === "string" && todo.assignee ? todo.assignee : undefined;
    const due = typeof todo.due === "string" && todo.due ? todo.due : undefined;
    const ids = sourceIds(Array.isArray(todo.sourceMessageIds) ? todo.sourceMessageIds : []);
    todos.push({
      id: todo.id,
      title: todo.title,
      done: todo.done === true,
      ...(assignee ? { assignee } : {}),
      ...(due ? { due } : {}),
      ...(ids.length ? { sourceMessageIds: ids } : {}),
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
