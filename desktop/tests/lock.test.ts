import { describe, expect, it } from "vitest";
import { createLockState, hashPin, validatePin, verifyPin } from "../electron/core/lock";

describe("PIN hashing", () => {
  it("verifies the right PIN and rejects a wrong one", () => {
    const rec = hashPin("1234");
    expect(rec.v).toBe(1);
    expect(verifyPin("1234", rec)).toBe(true);
    expect(verifyPin("1235", rec)).toBe(false);
    expect(verifyPin("", rec)).toBe(false);
  });

  it("uses a fresh random salt and never stores the plaintext PIN", () => {
    const a = hashPin("987654");
    const b = hashPin("987654");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(JSON.stringify(a)).not.toContain("987654");
    expect(Object.keys(a).sort()).toEqual(["hash", "salt", "v"]);
  });

  it("supports an explicit salt for deterministic verification", () => {
    const a = hashPin("1234");
    const b = hashPin("1234", a.salt);
    expect(b).toEqual(a);
    expect(verifyPin("1234", b)).toBe(true);
  });
});

describe("validatePin", () => {
  it("accepts only 4-12 digit PINs", () => {
    expect(validatePin("1234")).toBe(true);
    expect(validatePin("123456789012")).toBe(true);
    expect(validatePin("123")).toBe(false);
    expect(validatePin("1234567890123")).toBe(false);
    expect(validatePin("12a4")).toBe(false);
    expect(validatePin(" 1234")).toBe(false);
    expect(validatePin("")).toBe(false);
  });
});

describe("lockout state", () => {
  it("locks for 30s after five failures and allows the right PIN after cooldown", () => {
    let now = 0;
    const state = createLockState({ now: () => now });
    const rec = hashPin("1234");

    for (let i = 0; i < 4; i++) expect(state.attempt("0000", rec)).toEqual({ ok: false });
    expect(state.attempt("0000", rec)).toEqual({ ok: false, cooldownMs: 30_000 });

    // Even the correct PIN is refused during cooldown.
    expect(state.attempt("1234", rec)).toEqual({ ok: false, cooldownMs: 30_000 });

    now += 30_000;
    expect(state.attempt("1234", rec)).toEqual({ ok: true });
    expect(state.attempt("1234", rec)).toEqual({ ok: true });
  });

  it("resets failures after a successful attempt", () => {
    let now = 0;
    const state = createLockState({ now: () => now });
    const rec = hashPin("1234");
    for (let i = 0; i < 4; i++) state.attempt("0000", rec);
    expect(state.attempt("1234", rec)).toEqual({ ok: true });
    for (let i = 0; i < 4; i++) expect(state.attempt("0000", rec)).toEqual({ ok: false });
    expect(state.attempt("0000", rec)).toEqual({ ok: false, cooldownMs: 30_000 });
  });
});
