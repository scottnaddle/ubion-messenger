/**
 * Main-process orchestration: store + pipeline on messages + reminder ticks.
 */
import { Notification, nativeImage, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import type { ChatMessage, RoomKind } from "../types";
import { TodoStore } from "./store";
import { processMessage, type PipelineEvent } from "./pipeline";
import { planReminders, bossIconPath } from "./reminders";
import { buildZoomJoin } from "./zoom";
import { todosToIcs } from "./ics";
import type { TodoItem, TodoSettings } from "./types";
import { AiClient, aiConfig, LlmQueue, finalizeDue, inBand, type FetchLike } from "./llm";

export class TodoService {
  store = new TodoStore();
  private timer: NodeJS.Timeout | null = null;
  private fired = new Set<string>(); // dedupe key per day-ish
  private recentPrior = new Map<string, ChatMessage[]>();
  private onPipeline: ((ev: PipelineEvent) => void) | null = null;
  private getCalendarBusy: (() => boolean) | null = null;
  private resourcesDir: string;
  private llmQueue = new LlmQueue(async (m) => this.llmClient()?.classify(m) ?? null);

  /** Company-wide config baked in at build time; null → rule-only. */
  llmClient(fetchImpl: FetchLike = (u, i) => fetch(u, i as any) as any) {
    const cfg = aiConfig();
    if (!cfg) return null;
    return new AiClient({ baseUrl: cfg.baseUrl, model: cfg.model, getKey: () => cfg.key, fetch: fetchImpl, timeoutMs: 8000 });
  }

  constructor(resourcesDir: string) {
    this.resourcesDir = resourcesDir;
  }

  start(opts?: {
    onPipeline?: (ev: PipelineEvent) => void;
    getCalendarBusy?: () => boolean;
    resourcesDir?: string;
  }) {
    if (opts?.resourcesDir) this.resourcesDir = opts.resourcesDir;
    this.store.load();
    this.onPipeline = opts?.onPipeline || null;
    this.getCalendarBusy = opts?.getCalendarBusy || null;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 30_000);
    // first tick soon
    setTimeout(() => this.tick(), 5_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  noteHistory(roomKey: string, messages: ChatMessage[]) {
    const prev = this.recentPrior.get(roomKey) || [];
    const merged = [...prev, ...messages].slice(-40);
    this.recentPrior.set(roomKey, merged);
    if (!this.store.isRoomEnabled(roomKey)) return;
    for (const m of messages.slice(-40)) {
      // don't re-process ancient history aggressively — only last few without existing source
      this.handleMessage(m, roomKey, "unknown", false, undefined, true);
    }
  }

  handleMessage(
    msg: ChatMessage,
    roomKey: string,
    roomKind: RoomKind,
    isMine: boolean,
    mySeq?: number,
    fromHistory = false,
  ) {
    const prior = this.recentPrior.get(roomKey) || [];
    const list = [...prior, msg].slice(-40);
    this.recentPrior.set(roomKey, list);
    if (!this.store.isRoomEnabled(roomKey)) return null;
    // skip if already have todo sourced from this message
    if (msg.messageId && this.store.list().some((t) => t.source?.messageId === msg.messageId)) return null;
    const ev = processMessage(this.store, msg, {
      roomKey,
      roomKind,
      isMine,
      mySeq,
      prior: prior.slice(-6),
    });
    if (ev && !fromHistory) this.onPipeline?.(ev);
    if (ev?.type === "suggest" && !fromHistory) this.maybeAssist(ev.suggestion.id, msg, prior);
    else if (ev && fromHistory && ev.type === "auto") {
      // silent history backfill for enabled rooms
    }
    return ev;
  }

  /** Ambiguous band only, build-time AI config present. Failures leave the rule suggestion untouched. */
  private maybeAssist(sugId: string, msg: ChatMessage, prior: ChatMessage[]) {
    const sug = this.store.suggestions().find((x) => x.id === sugId);
    if (!aiConfig() || !sug || !inBand(sug.draft.confidence ?? 0)) return;
    const names = [msg.sendUserName, ...prior.map((p) => p.sendUserName)].filter(Boolean) as string[];
    const anchor = msg.createdAt || new Date().toISOString();
    this.llmQueue.push({
      id: sugId, text: msg.message || "", names, anchorIso: anchor,
      done: (v) => {
        if (!v) return;
        if (!v.isTask && v.confidence >= 0.8) return this.store.patchSuggestion(sugId, null);
        if (v.isTask) {
          const due = sug.draft.due || finalizeDue(v.dueText, anchor);
          this.store.patchSuggestion(sugId, { title: v.title || sug.draft.title, due });
        }
      },
    });
  }

  tick() {
    const settings = this.store.getSettings();
    const items = this.store.list({ status: "open" });
    const actions = planReminders(items, settings, new Date(), {
      inMeeting: this.getCalendarBusy?.() || false,
    });
    for (const a of actions) {
      const key = `${a.kind}:${a.todoId}:${a.kind === "zoom" ? a.minutesBefore : a.stage}`;
      if (this.fired.has(key)) continue;
      this.fired.add(key);
      // allow re-fire next day for overdue stage 3
      if (a.kind === "overdue" && a.stage === 3) {
        setTimeout(() => this.fired.delete(key), 20 * 3600_000);
      }
      this.notify(a);
      if (a.kind === "overdue") {
        this.store.update(a.todoId, { overdueStage: a.stage, lastOverdueAt: new Date().toISOString() });
      }
    }
    // prune fired set
    if (this.fired.size > 500) this.fired.clear();
  }

  private notify(a: import("./reminders").ReminderAction) {
    if (!Notification.isSupported()) return;
    let icon: Electron.NativeImage | undefined;
    if (a.kind === "overdue") {
      const p = bossIconPath(a.stage, this.resourcesDir);
      if (fs.existsSync(p)) icon = nativeImage.createFromPath(p);
    }
    const n = new Notification({
      title: a.title,
      body: a.body,
      icon,
      urgency: a.kind === "zoom" && a.minutesBefore <= 1 ? "critical" : "normal",
    });
    if (a.kind === "zoom") {
      n.on("click", () => void this.joinZoom(a.todoId));
      // macOS action buttons limited; click = join
    }
    n.show();
  }

  async joinZoom(todoId: string) {
    const it = this.store.get(todoId);
    if (!it) return false;
    const pwd = this.store.getPasscode(todoId);
    const j = buildZoomJoin({
      meetingId: it.zoomMeetingId,
      passcode: pwd,
      joinUrl: it.zoomJoinUrl,
    });
    try {
      await shell.openExternal(j.primary);
      return true;
    } catch {
      if (j.fallback) {
        await shell.openExternal(j.fallback);
        return true;
      }
      return false;
    }
  }

  exportIcs(): string {
    return todosToIcs(this.store.list());
  }

  settings(): TodoSettings {
    return this.store.getSettings();
  }

  /** For tests: inject short due */
  addTestTodo(partial: Partial<TodoItem> & { title: string }) {
    return this.store.add({
      type: "todo",
      status: "open",
      confidence: 1,
      origin: "manual",
      ...partial,
    } as any);
  }
}
