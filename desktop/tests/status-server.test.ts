import { describe, expect, it, vi } from "vitest";
import { createStatusClient } from "../electron/core/status-server";

const ok = (body: unknown, status = 200) => ({
  status,
  text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  headers: { get: () => null },
});

describe("status server client (unverified shape)", () => {
  it("GET returns the text from the documented shape", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ text: "점심시간" }));
    const c = createStatusClient({ baseUrl: "https://bot.ubion.global", getCookieHeader: async () => "a=b", fetch: fetch as any });
    await expect(c.get(42)).resolves.toEqual({ ok: true, text: "점심시간" });
    expect(fetch).toHaveBeenCalledWith("https://bot.ubion.global/v1/status/42", expect.objectContaining({ method: "GET" }));
  });

  it("PUT sends {text} and returns the stored text", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({ status: { text: "회의 중" } }));
    const c = createStatusClient({ baseUrl: "https://bot.ubion.global/", getCookieHeader: async () => "a=b", fetch: fetch as any });
    await expect(c.put(42, "회의 중")).resolves.toEqual({ ok: true, text: "회의 중" });
    expect(fetch).toHaveBeenCalledWith(
      "https://bot.ubion.global/v1/status/42",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ text: "회의 중" }) }),
    );
  });

  it("maps 401 to an auth failure and never leaks the cookie", async () => {
    const fetch = vi.fn().mockResolvedValue(ok("", 401));
    const c = createStatusClient({ getCookieHeader: async () => "secret=value", fetch: fetch as any });
    const r = await c.get(1);
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain("secret=value");
  });

  it("returns an empty text for a malformed body", async () => {
    const fetch = vi.fn().mockResolvedValue(ok({}));
    const c = createStatusClient({ getCookieHeader: async () => "a=b", fetch: fetch as any });
    await expect(c.get(1)).resolves.toEqual({ ok: true, text: "" });
  });

  it("fails cleanly on network errors", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("boom"));
    const c = createStatusClient({ getCookieHeader: async () => "a=b", fetch: fetch as any });
    const r = await c.get(1);
    expect(r.ok).toBe(false);
  });

  it("rejects cookies with newlines / oversized cookies", async () => {
    const fetch = vi.fn();
    const c = createStatusClient({ getCookieHeader: async () => "a\r\nb", fetch: fetch as any });
    const r = await c.get(1);
    expect(r.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
