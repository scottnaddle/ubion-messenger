/**
 * On-device todo store. Items in todos.json; Zoom passcodes in todo-secrets.bin via safeStorage.
 */
import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TodoItem, TodoSettings, TodoSuggestion } from "./types";
import { titleSimilarity } from "./extract";
import { isRoomCollecting } from "./rooms";

const DEFAULT_TODO_SETTINGS: TodoSettings = {
  enabledRooms: [],
  allRooms: false,
  disabledRooms: [],
  introSeen: false,
  remindersEnabled: true,
  workStartHour: 9,
  workEndHour: 19,
  quietDuringMeetings: true,
  zoomNotifyMinutes: [10, 1],
  llmFallback: false,
  politeMode: false,
};

type Db = {
  items: TodoItem[];
  suggestions: TodoSuggestion[];
  settings: TodoSettings;
  /** roomKey -> ignore streak */
  ignoreStreak: Record<string, number>;
};

function dbPath() {
  return path.join(app.getPath("userData"), "todos.json");
}
function secretsPath() {
  return path.join(app.getPath("userData"), "todo-secrets.bin");
}

function empty(): Db {
  return { items: [], suggestions: [], settings: { ...DEFAULT_TODO_SETTINGS }, ignoreStreak: {} };
}

export class TodoStore {
  private db: Db = empty();
  private secrets: Record<string, string> = {}; // todoId -> passcode

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(dbPath(), "utf8"));
      this.db = {
        items: raw.items || [],
        suggestions: raw.suggestions || [],
        settings: { ...DEFAULT_TODO_SETTINGS, ...(raw.settings || {}) },
        ignoreStreak: raw.ignoreStreak || {},
      };
      // Never persist passcodes in todos.json — strip if old bug wrote them
      for (const it of this.db.items) {
        delete (it as any).zoomPasscode;
      }
    } catch {
      this.db = empty();
    }
    try {
      if (safeStorage.isEncryptionAvailable() && fs.existsSync(secretsPath())) {
        this.secrets = JSON.parse(safeStorage.decryptString(fs.readFileSync(secretsPath())));
      }
    } catch {
      this.secrets = {};
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
    const safeItems = this.db.items.map((it) => {
      const { ...rest } = it;
      delete (rest as any).zoomPasscode;
      return rest;
    });
    fs.writeFileSync(dbPath(), JSON.stringify({ ...this.db, items: safeItems }, null, 2), { mode: 0o600 });
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(secretsPath(), safeStorage.encryptString(JSON.stringify(this.secrets)), { mode: 0o600 });
    }
  }

  getSettings(): TodoSettings {
    const s = { ...DEFAULT_TODO_SETTINGS, ...this.db.settings };
    return { ...s, enabledRooms: [...(s.enabledRooms || [])], disabledRooms: [...(s.disabledRooms || [])] };
  }

  updateSettings(patch: Partial<TodoSettings>) {
    this.db.settings = { ...this.db.settings, ...patch };
    if (patch.enabledRooms) this.db.settings.enabledRooms = [...patch.enabledRooms];
    this.persist();
    return this.getSettings();
  }

  isRoomEnabled(roomKey: string) {
    return isRoomCollecting(this.getSettings(), roomKey);
  }

  list(filter?: { status?: TodoItem["status"]; type?: TodoItem["type"] }): TodoItem[] {
    return this.db.items
      .filter((it) => (filter?.status ? it.status === filter.status : true))
      .filter((it) => (filter?.type ? it.type === filter.type : true))
      .map((it) => this.publicItem(it))
      .sort((a, b) => (a.due || a.start || a.createdAt).localeCompare(b.due || b.start || b.createdAt));
  }

  private publicItem(it: TodoItem): TodoItem {
    return {
      ...it,
      hasZoomPasscode: !!(it.id && this.secrets[it.id]),
    };
  }

  get(id: string): TodoItem | undefined {
    const it = this.db.items.find((x) => x.id === id);
    return it ? this.publicItem(it) : undefined;
  }

  add(input: Omit<TodoItem, "id" | "createdAt" | "updatedAt"> & { id?: string; zoomPasscode?: string }): TodoItem {
    const now = new Date().toISOString();
    const id = input.id || randomUUID();
    const { zoomPasscode, ...rest } = input as any;
    const item: TodoItem = {
      ...rest,
      id,
      createdAt: now,
      updatedAt: now,
      confidence: rest.confidence ?? 1,
      origin: rest.origin || "manual",
      status: rest.status || "open",
      hasZoomPasscode: !!zoomPasscode,
    };
    // dedupe
    const dup = this.findDupe(item);
    if (dup) {
      Object.assign(dup, {
        title: item.title || dup.title,
        due: item.due || dup.due,
        start: item.start || dup.start,
        updatedAt: now,
        zoomMeetingId: item.zoomMeetingId || dup.zoomMeetingId,
        zoomJoinUrl: item.zoomJoinUrl || dup.zoomJoinUrl,
      });
      if (zoomPasscode) this.secrets[dup.id] = zoomPasscode;
      this.persist();
      return this.publicItem(dup);
    }
    this.db.items.push(item);
    if (zoomPasscode) this.secrets[id] = zoomPasscode;
    this.persist();
    return this.publicItem(item);
  }

  findDupe(item: Pick<TodoItem, "roomKey" | "title" | "due" | "start" | "zoomMeetingId" | "assigneeSeq">): TodoItem | undefined {
    if (item.zoomMeetingId) {
      const byZoom = this.db.items.find(
        (x) => x.status === "open" && x.zoomMeetingId === item.zoomMeetingId && sameDay(x.start || x.due, item.start || item.due),
      );
      if (byZoom) return byZoom;
    }
    return this.db.items.find((x) => {
      if (x.status !== "open") return false;
      if (item.roomKey && x.roomKey && item.roomKey !== x.roomKey) return false;
      if (item.assigneeSeq != null && x.assigneeSeq != null && item.assigneeSeq !== x.assigneeSeq) return false;
      if (titleSimilarity(x.title, item.title) < 0.85) return false;
      return withinDays(x.due || x.start, item.due || item.start, 1);
    });
  }

  update(id: string, patch: Partial<TodoItem> & { zoomPasscode?: string | null }): TodoItem | undefined {
    const it = this.db.items.find((x) => x.id === id);
    if (!it) return undefined;
    const { zoomPasscode, ...rest } = patch as any;
    Object.assign(it, rest, { updatedAt: new Date().toISOString() });
    delete (it as any).zoomPasscode;
    if (zoomPasscode === null) delete this.secrets[id];
    else if (typeof zoomPasscode === "string") this.secrets[id] = zoomPasscode;
    it.hasZoomPasscode = !!this.secrets[id];
    this.persist();
    return this.publicItem(it);
  }

  complete(id: string) {
    return this.update(id, { status: "done", completedAt: new Date().toISOString() });
  }

  remove(id: string) {
    this.db.items = this.db.items.filter((x) => x.id !== id);
    delete this.secrets[id];
    this.db.suggestions = this.db.suggestions.filter((s) => (s as any).todoId !== id);
    this.persist();
  }

  deleteAllExtracted() {
    this.db.items = this.db.items.filter((x) => x.origin === "manual");
    this.db.suggestions = [];
    // drop secrets for removed
    const keep = new Set(this.db.items.map((x) => x.id));
    for (const k of Object.keys(this.secrets)) if (!keep.has(k)) delete this.secrets[k];
    this.persist();
  }

  getPasscode(id: string): string | undefined {
    return this.secrets[id];
  }

  suggestions() {
    return [...this.db.suggestions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  addSuggestion(s: Omit<TodoSuggestion, "id" | "createdAt"> & { id?: string }): TodoSuggestion {
    const sug: TodoSuggestion = {
      ...s,
      id: s.id || randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.db.suggestions.unshift(sug);
    this.persist();
    return sug;
  }

  acceptSuggestion(id: string): TodoItem | undefined {
    const s = this.db.suggestions.find((x) => x.id === id);
    if (!s) return undefined;
    this.db.suggestions = this.db.suggestions.filter((x) => x.id !== id);
    if (s.kind === "complete" && (s.draft as any).id) {
      return this.complete((s.draft as any).id);
    }
    return this.add({
      ...(s.draft as any),
      status: "open",
      origin: "suggested",
      confidence: s.draft.confidence ?? 0.7,
      type: s.draft.type || "todo",
      title: s.draft.title || "할 일",
    });
  }

  rejectSuggestion(id: string, roomKey?: string) {
    const s = this.db.suggestions.find((x) => x.id === id);
    this.db.suggestions = this.db.suggestions.filter((x) => x.id !== id);
    const rk = roomKey || s?.roomKey;
    if (rk) {
      this.db.ignoreStreak[rk] = (this.db.ignoreStreak[rk] || 0) + 1;
    }
    this.persist();
  }

  ignoreStreak(roomKey: string) {
    return this.db.ignoreStreak[roomKey] || 0;
  }

  clearIgnore(roomKey: string) {
    delete this.db.ignoreStreak[roomKey];
    this.persist();
  }
}

function sameDay(a?: string, b?: string) {
  if (!a || !b) return true;
  return a.slice(0, 10) === b.slice(0, 10);
}

function withinDays(a?: string, b?: string, days = 1) {
  if (!a || !b) return true;
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return true;
  return Math.abs(da - db) <= days * 86400000;
}

export { DEFAULT_TODO_SETTINGS };
