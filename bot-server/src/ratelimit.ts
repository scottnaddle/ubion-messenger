/** Token bucket per key. */
export class RateLimiter {
  private b = new Map<string, { t: number; at: number }>();
  constructor(private cap: number, private perSec: number, private now = () => Date.now()) {}
  take(key: string): { ok: boolean; retryAfterMs: number } {
    const n = this.now(); const s = this.b.get(key) ?? { t: this.cap, at: n };
    s.t = Math.min(this.cap, s.t + ((n - s.at) / 1000) * this.perSec); s.at = n;
    if (s.t >= 1) { s.t -= 1; this.b.set(key, s); return { ok: true, retryAfterMs: 0 }; }
    this.b.set(key, s); return { ok: false, retryAfterMs: Math.ceil(((1 - s.t) / this.perSec) * 1000) };
  }
}
