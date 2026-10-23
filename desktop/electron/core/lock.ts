import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Stored PIN verifier. Only a salted scrypt hash is persisted — never the PIN itself. */
export type PinRecord = {
  v: 1;
  salt: string; // base64, 16 random bytes
  hash: string; // base64, scrypt keylen 32
};

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 32;
const SALT_LEN = 16;

export function validatePin(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{4,12}$/.test(pin);
}

function saltBuffer(salt: string | Buffer): Buffer {
  if (Buffer.isBuffer(salt)) return salt;
  // The persisted form is base64. Fall back to treating unusual caller input as UTF-8.
  const decoded = Buffer.from(salt, "base64");
  return decoded.length > 0 && decoded.toString("base64").replace(/=+$/, "") === salt.replace(/=+$/, "")
    ? decoded
    : Buffer.from(salt, "utf8");
}

export function hashPin(pin: string, salt?: string | Buffer): PinRecord {
  const saltBuf = salt == null ? randomBytes(SALT_LEN) : saltBuffer(salt);
  const hash = scryptSync(pin, saltBuf, KEY_LEN, SCRYPT);
  return { v: 1, salt: saltBuf.toString("base64"), hash: hash.toString("base64") };
}

export function verifyPin(pin: string, rec: PinRecord | null | undefined): boolean {
  try {
    if (!rec || typeof pin !== "string" || typeof rec.salt !== "string" || typeof rec.hash !== "string") return false;
    const expected = Buffer.from(rec.hash, "base64");
    const actual = scryptSync(pin, Buffer.from(rec.salt, "base64"), KEY_LEN, SCRYPT);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export type LockAttemptResult =
  | { ok: true }
  | { ok: false; cooldownMs?: number };

export type LockState = {
  attempt(pin: string, rec: PinRecord): LockAttemptResult;
  recordFailure(): LockAttemptResult;
  reset(): void;
  readonly failedAttempts: number;
  readonly cooldownMs: number;
};

export const MAX_PIN_FAILURES = 5;
export const PIN_COOLDOWN_MS = 30_000;

/**
 * Tracks consecutive failed PIN attempts. After 5 failures the account is
 * blocked for 30 seconds; attempts during the cooldown return the remaining ms.
 */
export function createLockState(opts: { now?: (() => number) | number } = {}): LockState {
  const clock = typeof opts.now === "function"
    ? opts.now
    : typeof opts.now === "number"
      ? () => opts.now as number
      : () => Date.now();
  let failures = 0;
  let blockedUntil = 0;

  const remaining = () => {
    const ms = blockedUntil - clock();
    return ms > 0 ? ms : 0;
  };

  const recordFailure = (): LockAttemptResult => {
    const now = clock();
    if (blockedUntil > now) return { ok: false, cooldownMs: blockedUntil - now };
    failures++;
    if (failures >= MAX_PIN_FAILURES) {
      failures = 0;
      blockedUntil = now + PIN_COOLDOWN_MS;
      return { ok: false, cooldownMs: PIN_COOLDOWN_MS };
    }
    return { ok: false };
  };

  return {
    attempt(pin, rec) {
      const now = clock();
      if (blockedUntil > now) return { ok: false, cooldownMs: blockedUntil - now };
      if (verifyPin(pin, rec)) {
        failures = 0;
        blockedUntil = 0;
        return { ok: true };
      }
      return recordFailure();
    },
    recordFailure,
    reset() {
      failures = 0;
      blockedUntil = 0;
    },
    get failedAttempts() {
      return failures;
    },
    get cooldownMs() {
      return remaining();
    },
  };
}
