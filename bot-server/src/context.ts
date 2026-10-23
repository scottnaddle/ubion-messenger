import fs from "fs";
import path from "path";

/** Attachment metadata stored alongside a context message (no URLs, no binary data). */
export type StoredAttachment = { index: number; name: string; size: number | null; mime: string; file_id: string };

export type StoredMessage = {
  room_id: string;
  message_id: number;
  sender_id: string;
  sender_name: string;
  ts: string;
  text: string;
  attachments: StoredAttachment[];
  is_mine: boolean;
};

export type ListOptions = { since?: string; limit?: number };
export type RoomSummary = { room_id: string; count: number; last_ts: string };
export type RoomSettings = {
  room_id: string;
  autonomy: boolean;
  enabled_by: string | null;
  enabled_at: string | null;
  updated_by: string | null;
  updated_at: string | null;
};

export interface ContextStore {
  add(m: StoredMessage): void;
  list(room_id: string, opts: ListOptions): StoredMessage[];
  purgeRoom(room_id: string): number;
  prune(olderThanMs: number): number;
  rooms(): RoomSummary[];
  getSettings(room_id: string): RoomSettings;
  setSettings(room_id: string, autonomy: boolean, by: string): RoomSettings;
  close(): void;
}

function defaultSettings(room_id: string): RoomSettings {
  return { room_id, autonomy: false, enabled_by: null, enabled_at: null, updated_by: null, updated_at: null };
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function clampLimit(limit?: number): number {
  const n = Number(limit);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

function isNumericCursor(since: string): boolean {
  return /^\d+$/.test(since.trim());
}

function compareMessages(a: StoredMessage, b: StoredMessage): number {
  if (a.ts < b.ts) return -1;
  if (a.ts > b.ts) return 1;
  return a.message_id - b.message_id;
}

function select(rows: StoredMessage[], opts: ListOptions): StoredMessage[] {
  const limit = clampLimit(opts.limit);
  const since = opts.since == null ? undefined : String(opts.since).trim();
  let out = rows.slice().sort(compareMessages);
  if (since != null && since !== "") {
    out = isNumericCursor(since)
      ? out.filter((m) => m.message_id > Number(since))
      : out.filter((m) => m.ts > since);
    return out.slice(0, limit);
  }
  return out.slice(Math.max(0, out.length - limit));
}

function cloneMessage(m: StoredMessage): StoredMessage {
  return { ...m, attachments: m.attachments.map((a) => ({ ...a })) };
}

/** In-memory context store used by tests and small deployments. */
export class MemoryContextStore implements ContextStore {
  private byRoom = new Map<string, Map<number, StoredMessage>>();
  private settings = new Map<string, RoomSettings>();

  constructor(private now: () => number = Date.now) {}

  add(m: StoredMessage): void {
    let room = this.byRoom.get(m.room_id);
    if (!room) { room = new Map(); this.byRoom.set(m.room_id, room); }
    if (room.has(m.message_id)) return;
    room.set(m.message_id, cloneMessage(m));
  }

  list(room_id: string, opts: ListOptions = {}): StoredMessage[] {
    const room = this.byRoom.get(room_id);
    if (!room) return [];
    return select([...room.values()], opts).map(cloneMessage);
  }

  purgeRoom(room_id: string): number {
    const room = this.byRoom.get(room_id);
    if (!room) return 0;
    const n = room.size;
    this.byRoom.delete(room_id);
    return n;
  }

  prune(olderThanMs: number): number {
    const cutoff = this.now() - olderThanMs;
    let removed = 0;
    for (const [room_id, room] of this.byRoom) {
      for (const [message_id, m] of room) {
        const at = Date.parse(m.ts);
        if (Number.isFinite(at) && at < cutoff) { room.delete(message_id); removed++; }
      }
      if (!room.size) this.byRoom.delete(room_id);
    }
    return removed;
  }

  rooms(): RoomSummary[] {
    const out: RoomSummary[] = [];
    for (const [room_id, room] of this.byRoom) {
      if (!room.size) continue;
      let last_ts = "";
      for (const m of room.values()) if (m.ts > last_ts) last_ts = m.ts;
      out.push({ room_id, count: room.size, last_ts });
    }
    return out.sort((a, b) => a.room_id < b.room_id ? -1 : a.room_id > b.room_id ? 1 : 0);
  }

  getSettings(room_id: string): RoomSettings {
    const s = this.settings.get(room_id);
    return s ? { ...s } : defaultSettings(room_id);
  }

  setSettings(room_id: string, autonomy: boolean, by: string): RoomSettings {
    const prev = this.settings.get(room_id) ?? defaultSettings(room_id);
    const ts = new Date(this.now()).toISOString();
    const next: RoomSettings = {
      room_id,
      autonomy,
      enabled_by: autonomy ? by : prev.enabled_by,
      enabled_at: autonomy ? ts : prev.enabled_at,
      updated_by: by,
      updated_at: ts,
    };
    this.settings.set(room_id, next);
    return { ...next };
  }

  close(): void {}
}

type SqliteModule = typeof import("node:sqlite");

function loadSqlite(): SqliteModule {
  try {
    // Lazy on purpose: local typecheck/test may run on Node 20, production is Node 22+.
    return require("node:sqlite") as SqliteModule;
  } catch {
    throw new Error("node:sqlite is unavailable (requires Node.js 22+)");
  }
}

/** SQLite-backed context store. DatabaseSync is loaded lazily so Node 20 tooling still works. */
export class SqliteContextStore implements ContextStore {
  private db: import("node:sqlite").DatabaseSync;

  constructor(dbPath: string, private now: () => number = Date.now) {
    if (dbPath !== ":memory:") {
      const dir = path.dirname(dbPath);
      if (dir !== ".") {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
      }
    }
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ":memory:") {
      try { fs.chmodSync(dbPath, 0o600); } catch { /* best effort */ }
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        room_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        ts TEXT NOT NULL,
        text TEXT NOT NULL,
        attachments TEXT NOT NULL,
        is_mine INTEGER NOT NULL,
        PRIMARY KEY (room_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages (room_id, ts);
      CREATE TABLE IF NOT EXISTS room_settings (
        room_id TEXT PRIMARY KEY,
        autonomy INTEGER NOT NULL DEFAULT 0,
        enabled_by TEXT,
        enabled_at TEXT,
        updated_by TEXT,
        updated_at TEXT
      );
    `);
  }

  add(m: StoredMessage): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO messages (room_id, message_id, sender_id, sender_name, ts, text, attachments, is_mine) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(m.room_id, m.message_id, m.sender_id, m.sender_name, m.ts, m.text, JSON.stringify(m.attachments ?? []), m.is_mine ? 1 : 0);
  }

  list(room_id: string, opts: ListOptions = {}): StoredMessage[] {
    const limit = clampLimit(opts.limit);
    const since = opts.since == null ? undefined : String(opts.since).trim();
    let rows: Record<string, unknown>[];
    if (since != null && since !== "") {
      rows = isNumericCursor(since)
        ? this.db.prepare("SELECT * FROM messages WHERE room_id = ? AND message_id > ? ORDER BY ts ASC, message_id ASC LIMIT ?").all(room_id, Number(since), limit)
        : this.db.prepare("SELECT * FROM messages WHERE room_id = ? AND ts > ? ORDER BY ts ASC, message_id ASC LIMIT ?").all(room_id, since, limit);
    } else {
      rows = this.db.prepare(
        "SELECT * FROM (SELECT * FROM messages WHERE room_id = ? ORDER BY ts DESC, message_id DESC LIMIT ?) ORDER BY ts ASC, message_id ASC"
      ).all(room_id, limit);
    }
    return rows.map((row) => this.rowToMessage(row));
  }

  purgeRoom(room_id: string): number {
    return Number(this.db.prepare("DELETE FROM messages WHERE room_id = ?").run(room_id).changes);
  }

  prune(olderThanMs: number): number {
    const cutoff = new Date(this.now() - olderThanMs).toISOString();
    return Number(this.db.prepare("DELETE FROM messages WHERE ts < ?").run(cutoff).changes);
  }

  rooms(): RoomSummary[] {
    const rows = this.db.prepare("SELECT room_id, COUNT(*) AS count, MAX(ts) AS last_ts FROM messages GROUP BY room_id ORDER BY room_id ASC").all();
    return rows.map((row) => ({
      room_id: String(row.room_id ?? ""),
      count: Number(row.count ?? 0),
      last_ts: String(row.last_ts ?? ""),
    }));
  }

  getSettings(room_id: string): RoomSettings {
    const row = this.db.prepare("SELECT room_id, autonomy, enabled_by, enabled_at, updated_by, updated_at FROM room_settings WHERE room_id = ?").get(room_id) as Record<string, unknown> | undefined;
    if (!row) return defaultSettings(room_id);
    return {
      room_id: String(row.room_id ?? room_id),
      autonomy: Number(row.autonomy ?? 0) !== 0,
      enabled_by: row.enabled_by == null ? null : String(row.enabled_by),
      enabled_at: row.enabled_at == null ? null : String(row.enabled_at),
      updated_by: row.updated_by == null ? null : String(row.updated_by),
      updated_at: row.updated_at == null ? null : String(row.updated_at),
    };
  }

  setSettings(room_id: string, autonomy: boolean, by: string): RoomSettings {
    const prev = this.getSettings(room_id);
    const ts = new Date(this.now()).toISOString();
    const enabled_by = autonomy ? by : prev.enabled_by;
    const enabled_at = autonomy ? ts : prev.enabled_at;
    this.db.prepare(
      "INSERT INTO room_settings (room_id, autonomy, enabled_by, enabled_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(room_id) DO UPDATE SET autonomy = excluded.autonomy, enabled_by = excluded.enabled_by, enabled_at = excluded.enabled_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at"
    ).run(room_id, autonomy ? 1 : 0, enabled_by, enabled_at, by, ts);
    return { room_id, autonomy, enabled_by, enabled_at, updated_by: by, updated_at: ts };
  }

  close(): void { this.db.close(); }

  private rowToMessage(row: Record<string, unknown>): StoredMessage {
    let attachments: StoredAttachment[] = [];
    try {
      const parsed = JSON.parse(String(row.attachments ?? "[]"));
      if (Array.isArray(parsed)) attachments = parsed as StoredAttachment[];
    } catch { /* ignore malformed JSON */ }
    return {
      room_id: String(row.room_id ?? ""),
      message_id: Number(row.message_id ?? 0),
      sender_id: String(row.sender_id ?? ""),
      sender_name: String(row.sender_name ?? ""),
      ts: String(row.ts ?? ""),
      text: String(row.text ?? ""),
      attachments,
      is_mine: Number(row.is_mine ?? 0) !== 0,
    };
  }
}
