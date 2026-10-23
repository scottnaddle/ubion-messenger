/** Metadata-only audit (never message text, tokens, or credentials). */
export type AuditEntry = { ts: string; action: string; token_id?: string; room_id?: string; client_msg_id?: string; status: string; code?: string };
export class Audit {
  entries: AuditEntry[] = [];
  constructor(private sink: (line: string) => void = () => {}) {}
  log(e: Omit<AuditEntry, "ts">) { const x = { ts: new Date().toISOString(), ...e }; this.entries.push(x); if (this.entries.length > 1000) this.entries.shift(); this.sink(JSON.stringify(x)); }
}
