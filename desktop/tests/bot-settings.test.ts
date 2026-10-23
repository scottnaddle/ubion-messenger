import { describe, expect, it, vi } from "vitest";
import { createBotSettingsClient } from "../electron/core/bot-settings";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const settings = {
  room_id: "room:27673", autonomy: true, enabled_by: "8", enabled_at: "2026-01-01T00:00:00Z",
  updated_by: "8", updated_at: "2026-01-02T00:00:00Z", can_edit: true,
};

const client = (fetch: typeof globalThis.fetch, cookie = "GOSSOcookie=secret; other=yes") =>
  createBotSettingsClient({ getCookieHeader: async () => cookie, fetch });

describe("bot room settings client", () => {
  it("URL-encodes the room id and sends the Daou session header", async () => {
    const fetch = vi.fn(async () => json(settings));
    const r = await client(fetch).get("room:27673");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as any;
    expect(url).toBe("https://bot.ubion.global/bot/rooms/room%3A27673/settings");
    expect(init.headers["X-Daou-Session"]).toBe("GOSSOcookie=secret; other=yes");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(r).toEqual({
      ok: true,
      settings: { roomId: "room:27673", autonomy: true, updatedBy: "8", updatedAt: "2026-01-02T00:00:00Z" },
    });
  });

  it("PUTs the autonomy boolean as JSON and normalizes {settings}", async () => {
    const fetch = vi.fn(async () => json({ settings: { ...settings, autonomy: false }, notice_sent: true }));
    const r = await client(fetch).set("room:27673", false);
    const [url, init] = fetch.mock.calls[0] as any;
    expect(url).toBe("https://bot.ubion.global/bot/rooms/room%3A27673/settings");
    expect(init.method).toBe("PUT");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ autonomy: false });
    expect(r).toMatchObject({ ok: true, settings: { roomId: "room:27673", autonomy: false } });
  });

  it.each([
    [401, "auth"],
    [403, "forbidden"],
    [404, "unavailable"],
    [500, "unavailable"],
  ] as const)("maps HTTP %i to %s", async (status, kind) => {
    const r = await client(async () => json({ error: { code: "x", message: "secret details" } }, status)).get("room:1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe(kind);
  });

  it("maps 429 and keeps retry_after_s", async () => {
    const r = await client(async () => json({ error: { code: "rate_limited", retry_after_s: 7 } }, 429)).get("room:1");
    expect(r).toMatchObject({ ok: false, kind: "rate_limited", retryAfterS: 7 });
  });

  it("maps network failures and timeouts to network", async () => {
    const net = await client(async () => { throw new Error("offline"); }).get("room:1");
    expect(net).toMatchObject({ ok: false, kind: "network" });

    const timed = await createBotSettingsClient({
      getCookieHeader: async () => "a=b",
      timeoutMs: 5,
      fetch: slowFetch,
    }).get("room:1");
    expect(timed).toMatchObject({ ok: false, kind: "network" });
  });

  it("maps invalid JSON or a non-boolean autonomy to bad_response", async () => {
    const badJson = await client(async () => new Response("nope", { status: 200 })).get("room:1");
    expect(badJson).toMatchObject({ ok: false, kind: "bad_response" });
    const badShape = await client(async () => json({ room_id: "room:1", autonomy: "yes" })).get("room:1");
    expect(badShape).toMatchObject({ ok: false, kind: "bad_response" });
  });

  it("rejects oversized or CR/LF cookies without calling fetch or echoing the cookie", async () => {
    const fetch = vi.fn(async () => json(settings));
    const long = await client(fetch, "a".repeat(4097)).get("room:1");
    const crlf = await client(fetch, "a=b\r\nInjected: yes").get("room:1");
    expect(long).toMatchObject({ ok: false, kind: "auth" });
    expect(crlf).toMatchObject({ ok: false, kind: "auth" });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify([long, crlf])).not.toContain("a=b");
  });
});

function slowFetch(url: string | URL | Request, init?: RequestInit) {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });
}
