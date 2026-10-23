import type { BotEvent } from "./types";
/** Bounded in-memory ring; event_id is a monotonic decimal sequence so resume = "give me everything after N". */
export class EventLog {
  private buf: BotEvent[] = []; private seq = 0;
  constructor(private max = 5000) {}
  nextId() { return String(++this.seq); }
  push(e: BotEvent) { this.buf.push(e); if (this.buf.length > this.max) this.buf.shift(); }
  /** null = cursor too old (gap) → client must treat as reset. */
  after(id: string): BotEvent[] | null {
    const n = Number(id); if (!Number.isFinite(n)) return null;
    if (n >= this.seq) return [];
    const first = this.buf[0] ? Number(this.buf[0].event_id) : this.seq + 1;
    if (n < first - 1) return null;
    return this.buf.filter((e) => Number(e.event_id) > n);
  }
}
