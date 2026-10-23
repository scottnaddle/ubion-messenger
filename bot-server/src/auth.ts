import { createHash, timingSafeEqual } from "crypto";
export type Scope = "events:read" | "messages:send" | "rooms:read" | "files:read" | "context:read" | "settings:write";
export type TokenRecord = { id: string; sha256: string; scopes: Scope[]; rooms?: string[] };
export const hashToken = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
export class TokenStore {
  constructor(private recs: TokenRecord[]) {}
  /** Returns the matching record or null. Tokens are only ever stored as sha256. */
  verify(header: string | undefined): TokenRecord | null {
    const m = /^Bearer\s+(\S+)$/i.exec(header || "");
    if (!m) return null;
    const h = Buffer.from(hashToken(m[1]), "hex");
    for (const r of this.recs) {
      const b = Buffer.from(r.sha256, "hex");
      if (b.length === h.length && timingSafeEqual(b, h)) return r;
    }
    return null;
  }
}
export const hasScope = (r: TokenRecord, s: Scope) => r.scopes.includes(s);
export class Allowlist {
  private set: Set<string>;
  constructor(rooms: string[]) { this.set = new Set(rooms); }
  allows(room: string, tok?: TokenRecord) { return this.set.has(room) && (!tok?.rooms || tok.rooms.includes(room)); }
  rooms(): string[] { return [...this.set]; }
}
