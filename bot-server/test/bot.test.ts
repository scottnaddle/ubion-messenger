import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import WebSocket from "ws";
import { Allowlist, hashToken, TokenStore } from "../src/auth";
import { RateLimiter } from "../src/ratelimit";
import { ReloginPolicy, mask } from "../src/session";
import { BotServer } from "../src/server";
import { NotConfiguredPort, daouConfigured } from "../src/not-configured-port";
import type { BotRoom, DaouPort, InboundMessage } from "../src/types";

class MockDaou implements DaouPort {
  sends: Array<{ room_id: string; text: string }> = []; failNext = false; delay = 0;
  private mcb: Array<(m: InboundMessage) => void> = []; private rcb: Array<(r: BotRoom) => void> = [];
  botUserId() { return "99"; } botName() { return "봇"; } healthy() { return { state: "online" }; }
  async listRooms() { return [{ room_id: "room:1", room_name: "A" }, { room_id: "room:2", room_name: "Secret" }]; }
  async sendText(room_id: string, text: string) { if (this.delay) await new Promise((r) => setTimeout(r, this.delay)); if (this.failNext) { this.failNext = false; throw new Error("x"); } this.sends.push({ room_id, text }); return { message_id: this.sends.length }; }
  files: Array<{ room_id: string; name: string; size: number; data: Buffer }> = [];
  async sendFile(room_id: string, file: { name: string; data: Buffer; mime?: string }) { if (this.delay) await new Promise((r) => setTimeout(r, this.delay)); if (this.failNext) { this.failNext = false; throw new Error("x"); } this.files.push({ room_id, name: file.name, size: file.data.length, data: file.data }); return { message_id: 100 + this.files.length }; }
  deletes: Array<{ room_id: string; ids: number[] }> = [];
  async deleteMessages(room_id: string, ids: number[]) { this.deletes.push({ room_id, ids }); }
  onMessage(cb: (m: InboundMessage) => void) { this.mcb.push(cb); return () => {}; }
  onRoomJoined(cb: (r: BotRoom) => void) { this.rcb.push(cb); return () => {}; }
  msg(room_id: string, text: string, extra: Partial<InboundMessage> = {}) { this.mcb.forEach((f) => f({ room_id, message_id: 1, sender: { id: "5", name: "kim" }, text, mentions: [], attachments: [], reply_to: null, ts: "t", is_mine: false, ...extra })); }
  join(r: BotRoom) { this.rcb.forEach((f) => f(r)); }
}
const FULL = "tok-full", RO = "tok-ro";
let srv: BotServer, base: string, wsBase: string, daou: MockDaou;
async function setup(o: Partial<ConstructorParameters<typeof BotServer>[0]> = {}) {
  daou = new MockDaou();
  srv = new BotServer({ port: daou, allowlist: new Allowlist(["room:1", "room:3"]), tokens: new TokenStore([
    { id: "hermes", sha256: hashToken(FULL), scopes: ["events:read", "messages:send", "rooms:read"] },
    { id: "ro", sha256: hashToken(RO), scopes: ["events:read"] }]), ...o });
  const p = await srv.listen(0); base = `http://127.0.0.1:${p}`; wsBase = `ws://127.0.0.1:${p}`;
}
afterEach(async () => { await srv?.close(); });
const send = (b: object, t = FULL) => fetch(`${base}/bot/send`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify(b) });
function connect(t: string, after?: string) {
  const ws = new WebSocket(`${wsBase}/bot/ws${after ? `?after=${after}` : ""}`, { headers: { authorization: `Bearer ${t}` } });
  const got: any[] = []; ws.on("message", (d: any) => got.push(JSON.parse(String(d))));
  return new Promise<{ ws: WebSocket; got: any[] }>((res, rej) => { ws.on("open", () => res({ ws, got })); ws.on("error", rej); ws.on("unexpected-response", (_q: any, r: any) => rej(new Error(String(r.statusCode)))); });
}
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe("auth", () => {
  it("health is public, others need a valid bearer", async () => {
    await setup();
    expect((await fetch(`${base}/bot/health`)).status).toBe(200);
    expect((await fetch(`${base}/bot/rooms`)).status).toBe(401);
    expect((await fetch(`${base}/bot/rooms`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(`${base}/bot/rooms`, { headers: { authorization: `Bearer ${RO}` } })).status).toBe(403);
    expect((await send({ room_id: "room:1", text: "x", client_msg_id: "a" }, RO)).status).toBe(403);
  });
  it("ws rejects bad tokens", async () => { await setup(); await expect(connect("bad")).rejects.toThrow("401"); });
  it("tokens stored only as hashes", () => { expect(hashToken("a")).toMatch(/^[0-9a-f]{64}$/); expect(mask("botuser")).toBe("b***r"); });
});

describe("allowlist", () => {
  it("rooms list filtered, send to non-allowlisted refused, events dropped", async () => {
    await setup();
    const r = await (await fetch(`${base}/bot/rooms`, { headers: { authorization: `Bearer ${FULL}` } })).json();
    expect(r.rooms.map((x: any) => x.room_id)).toEqual(["room:1"]);
    const s = await send({ room_id: "room:2", text: "hi", client_msg_id: "c1" });
    expect(s.status).toBe(403); expect((await s.json()).error.code).toBe("room_not_allowed"); expect(daou.sends).toEqual([]);
    const c = await connect(FULL); daou.msg("room:2", "secret"); daou.msg("room:1", "ok"); await tick();
    expect(c.got.filter((e) => e.type === "message.created").map((e) => e.text)).toEqual(["ok"]); c.ws.close();
    expect(JSON.stringify(srv.audit.entries)).not.toContain("hi");
  });
  it("mention-only mode", async () => {
    await setup({ mentionOnly: true }); const c = await connect(FULL);
    daou.msg("room:1", "hello"); daou.msg("room:1", "@봇 help"); daou.msg("room:1", "x", { mentions: ["99"] }); await tick();
    expect(c.got.filter((e) => e.type === "message.created").map((e) => e.text)).toEqual(["@봇 help", "x"]); c.ws.close();
  });
});

describe("ws fan-out and resume", () => {
  it("fans out to all clients, ignores own msgs, emits room.joined and heartbeat", async () => {
    await setup({ heartbeatMs: 30 }); const a = await connect(FULL), b = await connect(RO);
    daou.msg("room:1", "m1"); daou.msg("room:1", "mine", { is_mine: true }); daou.join({ room_id: "room:3", room_name: "New" }); await tick(80);
    for (const c of [a, b]) {
      expect(c.got.filter((e) => e.type === "message.created").map((e) => [e.event_id, e.text, e.sender.name])).toEqual([["1", "m1", "kim"]]);
      expect(c.got.some((e) => e.type === "room.joined" && e.room_id === "room:3")).toBe(true);
      expect(c.got.some((e) => e.type === "heartbeat")).toBe(true);
    }
    a.ws.close(); b.ws.close();
  });
  it("resumes after last event_id, and reports gaps", async () => {
    await setup(); daou.msg("room:1", "m1"); daou.msg("room:1", "m2"); daou.msg("room:1", "m3");
    const c = await connect(FULL, "1"); await tick();
    expect(c.got.filter((e) => e.type === "message.created").map((e) => e.text)).toEqual(["m2", "m3"]); c.ws.close();
    for (let i = 0; i < 5100; i++) daou.msg("room:1", `x${i}`);
    const g = await connect(FULL, "2"); await tick(); expect(g.got.some((e) => e.type === "resume.gap")).toBe(true); g.ws.close();
  });
});

describe("send", () => {
  it("is idempotent by client_msg_id (sequential and concurrent)", async () => {
    await setup(); daou.delay = 30;
    const [a, b] = await Promise.all([send({ room_id: "room:1", text: "hi", client_msg_id: "k1" }), send({ room_id: "room:1", text: "hi", client_msg_id: "k1" })]);
    const c = await send({ room_id: "room:1", text: "hi", client_msg_id: "k1" });
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]); expect((await c.json()).duplicate).toBe(true); expect(daou.sends.length).toBe(1);
  });
  it("upstream failure is retryable with same id", async () => {
    await setup(); daou.failNext = true;
    expect((await send({ room_id: "room:1", text: "hi", client_msg_id: "k2" })).status).toBe(502);
    expect((await send({ room_id: "room:1", text: "hi", client_msg_id: "k2" })).status).toBe(200); expect(daou.sends.length).toBe(1);
  });
  it("validates body", async () => { await setup(); expect((await send({ room_id: "room:1", text: "" , client_msg_id: "z" })).status).toBe(400); expect((await send({ room_id: "room:1", text: "x" })).status).toBe(400); });
  it("rate limits with 429 + retry-after", async () => {
    await setup({ sendRate: { cap: 2, perSec: 0.1 }, roomRate: { cap: 100, perSec: 100 } });
    const st = []; for (let i = 0; i < 3; i++) st.push((await send({ room_id: "room:1", text: "x", client_msg_id: `r${i}` })).status);
    expect(st).toEqual([200, 200, 429]);
    const r = await send({ room_id: "room:1", text: "x", client_msg_id: "r9" }); expect(r.headers.get("retry-after")).toBeTruthy();
  });
});

describe("degraded mode", () => {
  it("daouConfigured rejects missing, blank, and placeholder credentials", () => {
    expect(daouConfigured("bot", "secret")).toBe(true);
    expect(daouConfigured()).toBe(false);
    expect(daouConfigured("bot", "")).toBe(false);
    expect(daouConfigured("   ", "secret")).toBe(false);
    expect(daouConfigured("bot", "  \t ")).toBe(false);
    expect(daouConfigured("bot", "CHANGEME")).toBe(false);
    expect(daouConfigured("changeMe-value", "secret")).toBe(false);
    expect(daouConfigured("bot", "my-placeholder")).toBe(false);
    expect(daouConfigured("PLACEHOLDER", "secret")).toBe(false);
  });
  it("health reports not_configured with 200", async () => {
    await setup({ port: new NotConfiguredPort() });
    const r = await fetch(`${base}/bot/health`);
    expect(r.status).toBe(200);
    expect((await r.json()).daou).toBe("not_configured");
  });
});

describe("units", () => {
  it("token bucket refills", () => { let t = 0; const r = new RateLimiter(1, 1, () => t); expect(r.take("a").ok).toBe(true); expect(r.take("a").ok).toBe(false); t = 1000; expect(r.take("a").ok).toBe(true); });
  it("relogin backoff grows and halts after 2 auth failures", () => {
    const p = new ReloginPolicy(); const a = p.onFailure("net", 0.5)!, b = p.onFailure("net", 0.5)!; expect(b).toBe(a * 2);
    expect(p.onFailure("auth")).not.toBeNull(); expect(p.onFailure("auth")).toBeNull(); expect(p.halted).toBe(true);
  });
});

const status = (b: object, t = FULL) => fetch(`${base}/bot/status`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify(b) });
describe("status placeholder", () => {
  it("thinking sends one placeholder; send() deletes it", async () => {
    await setup({ statusThrottleMs: 0 });
    const r = await status({ room_id: "room:1", state: "thinking" });
    expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ ok: true, state: "thinking", message_id: 1 });
    expect(daou.sends).toEqual([{ room_id: "room:1", text: "💭 생각 중…" }]);
    expect((await send({ room_id: "room:1", text: "answer", client_msg_id: "s1" })).status).toBe(200);
    expect(daou.deletes).toEqual([{ room_id: "room:1", ids: [1] }]);
    await send({ room_id: "room:1", text: "again", client_msg_id: "s2" }); expect(daou.deletes.length).toBe(1);
    expect(srv.audit.entries.some((e) => e.action === "status" && e.code === "thinking")).toBe(true);
  });
  it("working replaces previous placeholder (sanitized, max 60), done deletes", async () => {
    await setup({ statusThrottleMs: 0 });
    await status({ room_id: "room:1", state: "thinking" });
    await status({ room_id: "room:1", state: "working", text: "파일\n분석 " + "x".repeat(100) });
    expect(daou.sends[1].text).toBe("⚙️ 파일 분석 " + "x".repeat(54));
    expect(daou.deletes).toEqual([{ room_id: "room:1", ids: [1] }]);
    await status({ room_id: "room:1", state: "working" }); expect(daou.sends[2].text).toBe("⚙️ 작업 중…");
    const d = await (await status({ room_id: "room:1", state: "done" })).json();
    expect(d).toMatchObject({ ok: true, deleted: true }); expect(daou.deletes.map((x) => x.ids[0])).toEqual([1, 2, 3]);
    expect((await (await status({ room_id: "room:1", state: "done" })).json()).deleted).toBe(false);
  });
  it("throttles to 1 per window per room", async () => {
    await setup();
    expect((await (await status({ room_id: "room:1", state: "thinking" })).json()).throttled).toBeUndefined();
    const r = await status({ room_id: "room:1", state: "working" });
    expect(r.status).toBe(200); expect((await r.json()).throttled).toBe(true); expect(daou.sends.length).toBe(1);
  });
  it("auto-expires after 10 minutes", async () => {
    await setup({ statusThrottleMs: 0 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const tok = srv["o"].tokens.verify(`Bearer ${FULL}`)!;
      await srv.status(tok, { room_id: "room:1", state: "thinking" });
      vi.advanceTimersByTime(599_000); expect(daou.deletes.length).toBe(0);
      vi.advanceTimersByTime(2_000); await Promise.resolve(); await Promise.resolve();
      expect(daou.deletes).toEqual([{ room_id: "room:1", ids: [1] }]);
    } finally { vi.useRealTimers(); }
  });
  it("403 for non-allowlisted room and missing scope; 400 bad state", async () => {
    await setup({ statusThrottleMs: 0 });
    const a = await status({ room_id: "room:2", state: "thinking" }); expect(a.status).toBe(403); expect((await a.json()).error.code).toBe("room_not_allowed");
    const b = await status({ room_id: "room:1", state: "thinking" }, RO); expect(b.status).toBe(403); expect((await b.json()).error.code).toBe("forbidden_scope");
    expect((await status({ room_id: "room:1", state: "nap" })).status).toBe(400); expect(daou.sends).toEqual([]);
  });
  it("delete failure never throws out", async () => {
    await setup({ statusThrottleMs: 0, logger: () => {} }); daou.deleteMessages = async () => { throw new Error("boom"); };
    await status({ room_id: "room:1", state: "thinking" });
    expect((await send({ room_id: "room:1", text: "a", client_msg_id: "f1" })).status).toBe(200);
  });
});

const uploadDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("ubm-upload-")).length;
function fileForm(room_id: string | null, file: { name: string; body: string | Buffer; type?: string } | null, text?: string) {
  const fd = new FormData();
  if (room_id != null) fd.append("room_id", room_id);
  if (text != null) fd.append("text", text);
  if (file) fd.append("file", new Blob([file.body], { type: file.type ?? "application/octet-stream" }), file.name);
  return fd;
}
const postFile = (fd: FormData, t = FULL) => fetch(`${base}/bot/send-file`, { method: "POST", headers: { authorization: `Bearer ${t}` }, body: fd });

describe("send-file", () => {
  it("sends file then optional text, audits name/size, cleans temp dir", async () => {
    await setup();
    const before = uploadDirs();
    const r = await postFile(fileForm("room:1", { name: "hello.txt", body: "hello", type: "text/plain" }, "caption"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, message_id: 101, text_message_id: 1, file: { name: "hello.txt", size: 5 } });
    expect(daou.files).toEqual([{ room_id: "room:1", name: "hello.txt", size: 5, data: Buffer.from("hello") }]);
    expect(daou.sends).toEqual([{ room_id: "room:1", text: "caption" }]);
    expect(uploadDirs()).toBe(before);
    expect(srv.audit.entries).toContainEqual(expect.objectContaining({ action: "send_file", token_id: "hermes", room_id: "room:1", file_name: "hello.txt", file_size: 5, status: "ok" }));
  });
  it("400 for missing file/room_id and non-multipart", async () => {
    await setup();
    for (const fd of [fileForm("room:1", null), fileForm(null, { name: "a.txt", body: "x" })]) {
      const r = await postFile(fd);
      expect(r.status).toBe(400); expect((await r.json()).error.code).toBe("bad_request");
    }
    const r = await fetch(`${base}/bot/send-file`, { method: "POST", headers: { authorization: `Bearer ${FULL}`, "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(400); expect((await r.json()).error.code).toBe("bad_request");
    expect(daou.files).toEqual([]);
  });
  it("413 payload_too_large when total bytes exceed maxFileBytes, then cleans temp dir", async () => {
    await setup({ maxFileBytes: 128 });
    const before = uploadDirs();
    const r = await postFile(fileForm("room:1", { name: "big.bin", body: Buffer.alloc(1024, 7) }));
    expect(r.status).toBe(413); expect((await r.json()).error.code).toBe("payload_too_large");
    await tick();
    expect(uploadDirs()).toBe(before);
    expect(daou.files).toEqual([]);
  });
  it("403 room_not_allowed is audited and file is not sent", async () => {
    await setup();
    const r = await postFile(fileForm("room:2", { name: "secret.txt", body: "x" }));
    expect(r.status).toBe(403); expect((await r.json()).error.code).toBe("room_not_allowed");
    expect(daou.files).toEqual([]);
    expect(srv.audit.entries).toContainEqual(expect.objectContaining({ action: "send_file", token_id: "hermes", room_id: "room:2", file_name: "secret.txt", file_size: 1, status: "denied", code: "room_not_allowed" }));
  });
  it("403 forbidden_scope without messages:send", async () => {
    await setup();
    const r = await postFile(fileForm("room:1", { name: "a.txt", body: "x" }), RO);
    expect(r.status).toBe(403); expect((await r.json()).error.code).toBe("forbidden_scope");
    expect(daou.files).toEqual([]);
  });
  it("preserves Korean filename", async () => {
    await setup();
    const r = await postFile(fileForm("room:1", { name: "테스트.txt", body: "hi" }));
    expect(r.status).toBe(200);
    expect(daou.files[0].name).toBe("테스트.txt");
    expect((await r.json()).file).toEqual({ name: "테스트.txt", size: 2 });
  });
  it("deletes the room placeholder after send-file", async () => {
    await setup({ statusThrottleMs: 0 });
    await status({ room_id: "room:1", state: "thinking" });
    const r = await postFile(fileForm("room:1", { name: "a.txt", body: "x" }));
    expect(r.status).toBe(200);
    expect(daou.deletes).toEqual([{ room_id: "room:1", ids: [1] }]);
  });
  it("shares send/room rate limits and returns retry-after", async () => {
    await setup({ sendRate: { cap: 1, perSec: 0.1 }, roomRate: { cap: 100, perSec: 100 } });
    expect((await postFile(fileForm("room:1", { name: "a.txt", body: "x" }))).status).toBe(200);
    const r = await postFile(fileForm("room:1", { name: "b.txt", body: "y" }));
    expect(r.status).toBe(429); expect((await r.json()).error.code).toBe("rate_limited"); expect(r.headers.get("retry-after")).toBeTruthy();
  });
});
