/** Relogin policy for the single bot account: exponential backoff with jitter, and a hard stop
 *  after N consecutive credential failures so we never trip DaouOffice account lockout. */
export class ReloginPolicy {
  private fails = 0; authFails = 0; halted = false;
  constructor(private o = { baseMs: 5_000, maxMs: 15 * 60_000, maxAuthFails: 2 }) {}
  /** kind "auth" = server rejected credentials/OTP; "net" = transient. Returns delay or null (halted: needs operator). */
  onFailure(kind: "auth" | "net", rnd = Math.random()): number | null {
    if (kind === "auth" && ++this.authFails >= this.o.maxAuthFails) { this.halted = true; return null; }
    const d = Math.min(this.o.maxMs, this.o.baseMs * 2 ** this.fails++);
    return Math.round(d * (0.8 + 0.4 * rnd));
  }
  onSuccess() { this.fails = 0; this.authFails = 0; }
}
export const mask = (s: string) => (s.length <= 2 ? "**" : `${s[0]}***${s[s.length - 1]}`);
