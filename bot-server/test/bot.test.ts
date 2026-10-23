import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import WebSocket from "ws";
import { Allowlist, hashToken, TokenStore } from "../src/auth";
import { MemoryContextStore, SqliteContextStore } from "../src/context";
import { RateLimiter } from "../src/ratelimit";
import { ReloginPolicy, mask } from "../src/session";
import { BotServer } from "../src/server";
import { NotConfiguredPort, daouConfigured } from "../src/not-configured-port";
import type { BotRoom, DaouPort, InboundMessage } from "../src/types";
import { extractText, stripTags } from "../src/extract";

class MockDaou implements DaouPort {
  sends: Array<{ room_id: string; text: string }> = []; failNext = false; delay = 0;
  private mcb: Array<(m: InboundMessage) => void> = []; private rcb: Array<(r: BotRoom) => void> = [];
  botUserId() { return "99"; } botName() { return "봇"; } healthy() { return { state: "online" }; }
  async listRooms() { return [{ room_id: "room:1", room_name: "A", kind: "room", member_count: 5 }, { room_id: "room:2", room_name: "Secret", kind: "buddy", member_count: 2 }]; }
  async sendText(room_id: string, text: string) { if (this.delay) await new Promise((r) => setTimeout(r, this.delay)); if (this.failNext) { this.failNext = false; throw new Error("x"); } this.sends.push({ room_id, text }); return { message_id: this.sends.length }; }
  files: Array<{ room_id: string; name: string; size: number; data: Buffer }> = [];
  async sendFile(room_id: string, file: { name: string; data: Buffer; mime?: string }) { if (this.delay) await new Promise((r) => setTimeout(r, this.delay)); if (this.failNext) { this.failNext = false; throw new Error("x"); } this.files.push({ room_id, name: file.name, size: file.data.length, data: file.data }); return { message_id: 100 + this.files.length }; }
  deletes: Array<{ room_id: string; ids: number[] }> = [];
  async deleteMessages(room_id: string, ids: number[]) { this.deletes.push({ room_id, ids }); }
  onMessage(cb: (m: InboundMessage) => void) { this.mcb.push(cb); return () => {}; }
  onRoomJoined(cb: (r: BotRoom) => void) { this.rcb.push(cb); return () => {}; }
  attachments = new Map<number, Array<{ name: string; size?: number; mime?: string; file_id: string; image?: boolean }>>();
  binary = new Map<string, { data: Buffer; contentType?: string }>();
  attachmentLookups = 0;
  emptyLookups = 0;
  async getAttachments(_room_id: string, message_id: number) {
    this.attachmentLookups++;
    if (this.emptyLookups > 0) { this.emptyLookups--; return []; }
    return this.attachments.get(message_id) ?? [];
  }
  async downloadAttachment(_room_id: string, message_id: number, index: number, file_id?: string, maxBytes?: number) {
    const all = this.attachments.get(message_id) ?? [];
    const a = file_id ? all.find((x) => x.file_id === file_id) : all[index];
    if (!a) throw new Error("not found");
    const b = this.binary.get(a.file_id);
    if (!b) throw new Error("not found");
    if (maxBytes != null && b.data.length > maxBytes) throw Object.assign(new Error("too large"), { status: 413 });
    return { data: b.data, contentType: b.contentType || a.mime || "application/octet-stream", name: a.name };
  }
  sessions = new Map<string, { user_id: string; name: string } | null>();
  roomMembers = new Map<string, string[]>();
  verifyCalls = 0;
  isRoomMemberCalls = 0;
  async verifyUserSession(cookie: string) {
    this.verifyCalls++;
    return this.sessions.get(cookie) ?? null;
  }
  async isRoomMember(room_id: string, user_id: string) {
    this.isRoomMemberCalls++;
    return (this.roomMembers.get(room_id) ?? []).includes(user_id);
  }
  msg(room_id: string, text: string, extra: Partial<InboundMessage> = {}) { this.mcb.forEach((f) => f({ room_id, message_id: 1, sender: { id: "5", name: "kim" }, text, mentions: [], attachments: [], reply_to: null, ts: "t", is_mine: false, ...extra })); }
  join(r: BotRoom) { this.rcb.forEach((f) => f(r)); }
}
const FULL = "tok-full", RO = "tok-ro", ROOMS = "tok-rooms", CTX = "tok-ctx", CTX_ROOM = "tok-ctx-room", SET = "tok-set", SET_ROOM = "tok-set-room";
let srv: BotServer, base: string, wsBase: string, daou: MockDaou;
async function setup(o: Partial<ConstructorParameters<typeof BotServer>[0]> = {}) {
  daou = new MockDaou();
  srv = new BotServer({ port: daou, allowlist: new Allowlist(["room:1", "room:3"]), tokens: new TokenStore([
    { id: "hermes", sha256: hashToken(FULL), scopes: ["events:read", "messages:send", "rooms:read", "files:read"] },
    { id: "ro", sha256: hashToken(RO), scopes: ["events:read"] },
    { id: "rooms", sha256: hashToken(ROOMS), scopes: ["rooms:read"] },
    { id: "ctx", sha256: hashToken(CTX), scopes: ["events:read", "context:read"] },
    { id: "ctx-room", sha256: hashToken(CTX_ROOM), scopes: ["events:read", "context:read"], rooms: ["room:1"] },
    { id: "set", sha256: hashToken(SET), scopes: ["settings:write"] },
    { id: "set-room", sha256: hashToken(SET_ROOM), scopes: ["settings:write"], rooms: ["room:1"] }]), ...o });
  const p = await srv.listen(0); base = `http://127.0.0.1:${p}`; wsBase = `ws://127.0.0.1:${p}`;
}
afterEach(async () => { await srv?.close(); });
const send = (b: object, t = FULL) => fetch(`${base}/bot/send`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify(b) });
function connect(t: string, after?: string) {
  const ws = new WebSocket(`${wsBase}/bot/ws${after ? `?after=${after}` : ""}`, { headers: { authorization: `Bearer ${t}` } });
  const got: any[] = []; ws.on("message", (d: any) => got.push(JSON.parse(String(d))));
  return new Promise<{ ws: WebSocket; got: any[] }>((res, rej) => { ws.on("open", () => res({ ws, got })); ws.on("error", rej); ws.on("unexpected-response", (_q: any, r: any) => rej(new Error(String(r.statusCode)))); });
}
const asMember = () => { daou.sessions.set("ck", { user_id: "5", name: "kim" }); for (const r of ["room:1", "room:2", "room:9"]) daou.roomMembers.set(r, ["5"]); };
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

const hasSqlite = (() => { try { require("node:sqlite"); return true; } catch { return false; } })();
const sm = (room_id: string, message_id: number, ts: string, text = `m${message_id}`, is_mine = false) => ({
  room_id, message_id, sender_id: "5", sender_name: "kim", ts, text, attachments: [], is_mine,
});

describe("context stores", () => {
  it("MemoryContextStore dedupes, lists with since/limit, purges, prunes, summarizes", () => {
    let now = Date.parse("2024-01-10T00:00:00.000Z");
    const store = new MemoryContextStore(() => now);
    store.add(sm("room:2", 2, "2024-01-01T00:00:02.000Z", "b"));
    store.add(sm("room:2", 1, "2024-01-01T00:00:01.000Z", "a"));
    store.add(sm("room:2", 3, "2024-01-01T00:00:03.000Z", "c"));
    store.add(sm("room:2", 3, "2024-01-01T00:00:03.000Z", "duplicate"));

    expect(store.list("room:2").map((m) => m.text)).toEqual(["a", "b", "c"]);
    expect(store.list("room:2", { limit: 2 }).map((m) => m.message_id)).toEqual([2, 3]);
    expect(store.list("room:2", { since: "1" }).map((m) => m.message_id)).toEqual([2, 3]);
    expect(store.list("room:2", { since: "2024-01-01T00:00:01.000Z" }).map((m) => m.message_id)).toEqual([2, 3]);
    expect(store.rooms()).toEqual([{ room_id: "room:2", count: 3, last_ts: "2024-01-01T00:00:03.000Z" }]);
    expect(store.purgeRoom("room:2")).toBe(3);
    expect(store.list("room:2")).toEqual([]);

    store.add(sm("room:1", 10, "2024-01-01T00:00:00.000Z", "old"));
    store.add(sm("room:1", 11, "2024-01-09T00:00:00.000Z", "new"));
    expect(store.prune(2 * 24 * 3600_000)).toBe(1);
    expect(store.list("room:1").map((m) => m.message_id)).toEqual([11]);
    now = Date.parse("2024-01-20T00:00:00.000Z");
    expect(store.prune(0)).toBe(1);
    expect(store.rooms()).toEqual([]);
  });

  it("MemoryContextStore keeps room autonomy settings", () => {
    let now = Date.parse("2024-01-10T00:00:00.000Z");
    const store = new MemoryContextStore(() => now);
    expect(store.getSettings("room:1")).toEqual({ room_id: "room:1", autonomy: false, enabled_by: null, enabled_at: null, updated_by: null, updated_at: null });
    const on = store.setSettings("room:1", true, "u1");
    expect(on).toMatchObject({ room_id: "room:1", autonomy: true, enabled_by: "u1", enabled_at: "2024-01-10T00:00:00.000Z", updated_by: "u1", updated_at: "2024-01-10T00:00:00.000Z" });
    now += 5000;
    const off = store.setSettings("room:1", false, "u2");
    expect(off).toMatchObject({ autonomy: false, enabled_by: "u1", enabled_at: "2024-01-10T00:00:00.000Z", updated_by: "u2", updated_at: "2024-01-10T00:00:05.000Z" });
    expect(store.getSettings("room:1")).toEqual(off);
  });

  (hasSqlite ? it : it.skip)("SqliteContextStore persists, dedupes, lists and purges", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ubm-ctx-"));
    const db = path.join(dir, "nested", "context.db");
    let store = new SqliteContextStore(db, () => Date.parse("2024-01-10T00:00:00.000Z"));
    try {
      store.add(sm("room:2", 1, "2024-01-01T00:00:01.000Z", "a"));
      store.add({ ...sm("room:2", 2, "2024-01-01T00:00:02.000Z", "b"), attachments: [{ index: 0, name: "a.txt", size: 1, mime: "text/plain", file_id: "f1" }] });
      store.add(sm("room:2", 2, "2024-01-01T00:00:02.000Z", "duplicate"));
      store.add(sm("room:1", 3, "2024-01-01T00:00:03.000Z", "c"));
      store.close();
      store = new SqliteContextStore(db, () => Date.parse("2024-01-10T00:00:00.000Z"));
      expect(store.list("room:2").map((m) => m.text)).toEqual(["a", "b"]);
      expect(store.list("room:2")[1].attachments[0]).toEqual({ index: 0, name: "a.txt", size: 1, mime: "text/plain", file_id: "f1" });
      expect(store.list("room:2", { since: "1" }).map((m) => m.message_id)).toEqual([2]);
      expect(store.rooms()).toEqual([
        { room_id: "room:1", count: 1, last_ts: "2024-01-01T00:00:03.000Z" },
        { room_id: "room:2", count: 2, last_ts: "2024-01-01T00:00:02.000Z" },
      ]);
      expect(store.getSettings("room:3")).toMatchObject({ room_id: "room:3", autonomy: false, enabled_by: null });
      const on = store.setSettings("room:3", true, "u1");
      expect(on).toMatchObject({ autonomy: true, enabled_by: "u1", updated_by: "u1" });
      const off = store.setSettings("room:3", false, "u2");
      expect(off).toMatchObject({ autonomy: false, enabled_by: "u1", updated_by: "u2" });
      expect(store.getSettings("room:3")).toEqual(off);
      expect(store.purgeRoom("room:2")).toBe(2);
      expect(store.prune(0)).toBe(1);
      expect(store.rooms()).toEqual([]);
    } finally {
      try { store.close(); } catch { /* already closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("context server", () => {
  it("stores context-room messages before filtering without events or sends", async () => {
    const store = new MemoryContextStore();
    store.setSettings("room:2", true, "test");
    await setup({ context: { store } });
    const c = await connect(FULL);
    daou.msg("room:2", "secret", { message_id: 10, ts: "2024-01-01T00:00:01.000Z" });
    daou.msg("room:2", "bot", { message_id: 11, ts: "2024-01-01T00:00:02.000Z", is_mine: true });
    daou.msg("room:1", "ok", { message_id: 12, ts: "2024-01-01T00:00:03.000Z" });
    await tick();
    expect(store.list("room:2").map((m) => [m.message_id, m.text, m.is_mine])).toEqual([[10, "secret", false], [11, "bot", true]]);
    expect(c.got.filter((e) => e.type === "message.created").map((e) => e.text)).toEqual(["ok"]);
    expect(daou.sends).toEqual([]);
    c.ws.close();
  });

  it("keeps mention-only behaviour for context rooms", async () => {
    const store = new MemoryContextStore();
    store.setSettings("room:2", true, "test");
    await setup({ mentionOnly: true, context: { store } });
    const c = await connect(FULL);
    daou.msg("room:2", "hello", { message_id: 1, ts: "2024-01-01T00:00:01.000Z" });
    await tick();
    expect(store.list("room:2")).toHaveLength(1);
    expect(c.got.filter((e) => e.type === "message.created")).toEqual([]);
    c.ws.close();
  });

  it("stores enriched attachment metadata for an allowlisted context room", async () => {
    const store = new MemoryContextStore();
    store.setSettings("room:1", true, "test");
    await setup({ attachRetryMs: [0], context: { store } });
    daou.attachments.set(20, [{ name: "a.pdf", size: 9, mime: "application/pdf", file_id: "f20" }]);
    daou.msg("room:1", "a.pdf", { message_id: 20, messageType: "SENDFILE", ts: "2024-01-01T00:00:01.000Z" });
    await tick(100);
    expect(store.list("room:1")[0].attachments).toEqual([{ index: 0, name: "a.pdf", size: 9, mime: "application/pdf", file_id: "f20" }]);
  });

  it("rooms include kind/member_count/autonomy; all=1 needs context:read", async () => {
    const store = new MemoryContextStore();
    store.setSettings("room:2", true, "test");
    await setup({ context: { store } });
    const normal = await (await fetch(`${base}/bot/rooms`, { headers: { authorization: `Bearer ${FULL}` } })).json();
    expect(normal.rooms).toEqual([{ room_id: "room:1", room_name: "A", kind: "room", member_count: 5, autonomy: false }]);

    const denied = await fetch(`${base}/bot/rooms?all=1`, { headers: { authorization: `Bearer ${FULL}` } });
    expect(denied.status).toBe(403); expect((await denied.json()).error.code).toBe("forbidden_scope");

    const all = await (await fetch(`${base}/bot/rooms?all=1`, { headers: { authorization: `Bearer ${CTX}` } })).json();
    expect(all.rooms.map((r: any) => r.room_id)).toEqual(["room:1", "room:2"]);
    expect(all.rooms[1]).toMatchObject({ room_id: "room:2", kind: "buddy", member_count: 2, autonomy: true });
  });

  it("messages endpoint handles 401, 403 scope, 403 room, since/limit and audit", async () => {
    const store = new MemoryContextStore();
    store.setSettings("room:2", true, "test");
    await setup({ context: { store } });
    for (let i = 1; i <= 5; i++) store.add(sm("room:2", i, `2024-01-01T00:00:0${i}.000Z`, `secret-body-${i}`));

    expect((await fetch(`${base}/bot/rooms/room%3A2/messages`)).status).toBe(401);
    const scope = await fetch(`${base}/bot/rooms/room%3A2/messages`, { headers: { authorization: `Bearer ${FULL}` } });
    expect(scope.status).toBe(403); expect((await scope.json()).error.code).toBe("forbidden_scope");

    const room = await fetch(`${base}/bot/rooms/${encodeURIComponent("room:2")}/messages`, { headers: { authorization: `Bearer ${CTX_ROOM}` } });
    expect(room.status).toBe(403); expect((await room.json()).error.code).toBe("room_not_allowed");
    const notContext = await fetch(`${base}/bot/rooms/${encodeURIComponent("room:1")}/messages`, { headers: { authorization: `Bearer ${CTX}` } });
    expect(notContext.status).toBe(403); expect((await notContext.json()).error.code).toBe("room_not_allowed");

    let r = await (await fetch(`${base}/bot/rooms/${encodeURIComponent("room:2")}/messages?limit=2`, { headers: { authorization: `Bearer ${CTX}` } })).json();
    expect(r.messages.map((m: any) => m.message_id)).toEqual([4, 5]);
    expect(r.next_since).toBe("2024-01-01T00:00:05.000Z");
    r = await (await fetch(`${base}/bot/rooms/${encodeURIComponent("room:2")}/messages?since=2&limit=2`, { headers: { authorization: `Bearer ${CTX}` } })).json();
    expect(r.messages.map((m: any) => m.message_id)).toEqual([3, 4]);
    expect(r.next_since).toBe("4");
    r = await (await fetch(`${base}/bot/rooms/${encodeURIComponent("room:2")}/messages?since=${encodeURIComponent("2024-01-01T00:00:02.000Z")}`, { headers: { authorization: `Bearer ${CTX}` } })).json();
    expect(r.messages.map((m: any) => m.message_id)).toEqual([3, 4, 5]);
    expect(srv.audit.entries).toContainEqual(expect.objectContaining({ action: "context_read", token_id: "ctx", room_id: "room:2", count: 3, status: "ok" }));
    expect(JSON.stringify(srv.audit.entries)).not.toContain("secret-body");
  });

  it("404 context_disabled when context is not configured", async () => {
    await setup();
    const r = await fetch(`${base}/bot/rooms/room%3A2/messages`, { headers: { authorization: `Bearer ${CTX}` } });
    expect(r.status).toBe(404); expect((await r.json()).error.code).toBe("context_disabled");
    const s = await fetch(`${base}/bot/rooms/room%3A2/settings`, { headers: { authorization: `Bearer ${SET}` } });
    expect(s.status).toBe(404); expect((await s.json()).error.code).toBe("context_disabled");
  });

  it("settings: GET with Bearer, PUT only by a member session; notices on change with per-room cooldown", async () => {
    const store = new MemoryContextStore();
    let clock = 1_000_000;
    await setup({ context: { store }, now: () => clock });
    asMember();
    const url = `${base}/bot/rooms/${encodeURIComponent("room:9")}/settings`;
    const auth = { authorization: `Bearer ${SET}`, "content-type": "application/json" };
    const human = { "x-daou-session": "ck", "content-type": "application/json" };
    let r = await fetch(url, { headers: auth });
    const tokPut = await fetch(url, { method: "PUT", headers: auth, body: JSON.stringify({ autonomy: true }) });
    expect(tokPut.status).toBe(403); expect((await tokPut.json()).error.code).toBe("human_session_required");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ room_id: "room:9", autonomy: false, enabled_by: null, enabled_at: null, updated_by: null, updated_at: null, can_edit: true });

    r = await fetch(url, { method: "PUT", headers: human, body: JSON.stringify({ autonomy: true }) });
    const on = await r.json();
    expect(r.status).toBe(200);
    expect(on.notice_sent).toBe(true);
    expect(on.settings).toMatchObject({ room_id: "room:9", autonomy: true, enabled_by: "5", updated_by: "5", can_edit: true });
    expect(on.settings.enabled_at).toBeTruthy();
    expect(daou.sends).toEqual([{ room_id: "room:9", text: "유비온봇 자율활동이 켜졌습니다. 이 방의 대화를 기록하고, 대화가 끝나면 정리해 드립니다. (끄기: 방 설정 > 유비온봇 자율활동)" }]);

    r = await fetch(url, { method: "PUT", headers: human, body: JSON.stringify({ autonomy: true }) });
    expect((await r.json()).notice_sent).toBe(false);
    expect(daou.sends).toHaveLength(1);

    clock += 31_000;
    r = await fetch(url, { method: "PUT", headers: human, body: JSON.stringify({ autonomy: false }) });
    const off = await r.json();
    expect(off.notice_sent).toBe(true);
    expect(off.settings).toMatchObject({ room_id: "room:9", autonomy: false, enabled_by: "5", updated_by: "5" });
    expect(daou.sends).toHaveLength(2);
    expect(daou.sends[1].text).toBe("유비온봇 자율활동이 꺼졌습니다. 이제 이 방의 대화를 기록하지 않습니다. (멘션하면 계속 답합니다)");
    expect(srv.audit.entries).toContainEqual(expect.objectContaining({ action: "settings_update", room_id: "room:9", actor: "5", autonomy: true, status: "ok" }));

    const ctxGet = await fetch(url, { headers: { authorization: `Bearer ${CTX}` } });
    expect(ctxGet.status).toBe(200);
    const ctxPut = await fetch(url, { method: "PUT", headers: { authorization: `Bearer ${CTX}`, "content-type": "application/json" }, body: JSON.stringify({ autonomy: true }) });
    expect(ctxPut.status).toBe(403); expect((await ctxPut.json()).error.code).toBe("human_session_required");
    const restricted = await fetch(`${base}/bot/rooms/${encodeURIComponent("room:2")}/settings`, { headers: { authorization: `Bearer ${SET_ROOM}` } });
    expect(restricted.status).toBe(403);
    const allowed = await fetch(`${base}/bot/rooms/${encodeURIComponent("room:1")}/settings`, { headers: { authorization: `Bearer ${SET_ROOM}` } });
    expect(allowed.status).toBe(200);
  });

  it("settings with X-Daou-Session verifies the user and room membership", async () => {
    const store = new MemoryContextStore();
    await setup({ context: { store } });
    daou.sessions.set("cookie-5", { user_id: "5", name: "kim" });
    daou.roomMembers.set("room:2", ["5"]);
    daou.roomMembers.set("buddy:5", ["5"]);
    const headers = { "x-daou-session": "cookie-5", "content-type": "application/json" };
    const url = (r: string) => `${base}/bot/rooms/${encodeURIComponent(r)}/settings`;

    let r = await fetch(url("room:2"), { headers });
    expect(r.status).toBe(200);
    r = await fetch(url("room:2"), { method: "PUT", headers, body: JSON.stringify({ autonomy: true }) });
    const put = await r.json();
    expect(r.status).toBe(200);
    expect(put.settings).toMatchObject({ room_id: "room:2", autonomy: true, enabled_by: "5", updated_by: "5" });
    expect(put.notice_sent).toBe(true);
    expect(daou.sends.map((s) => s.room_id)).toEqual(["room:2"]);

    const bad = await fetch(url("room:2"), { headers: { "x-daou-session": "nope" } });
    expect(bad.status).toBe(401); expect((await bad.json()).error.code).toBe("invalid_session");
    const nonMember = await fetch(url("room:1"), { headers });
    expect(nonMember.status).toBe(403); expect((await nonMember.json()).error.code).toBe("not_room_member");
    const buddy = await fetch(url("buddy:5"), { headers });
    expect(buddy.status).toBe(200);
    const otherBuddy = await fetch(url("buddy:6"), { headers });
    expect(otherBuddy.status).toBe(403);

    const calls = daou.verifyCalls;
    const huge = await fetch(url("room:2"), { headers: { "x-daou-session": "x".repeat(4097) } });
    expect(huge.status).toBe(401); expect((await huge.json()).error.code).toBe("invalid_session");
    expect(daou.verifyCalls).toBe(calls);
  });

  it("rate limits human settings requests per user", async () => {
    const store = new MemoryContextStore();
    await setup({ context: { store } });
    daou.sessions.set("cookie-5", { user_id: "5", name: "kim" });
    daou.roomMembers.set("room:1", ["5"]);
    const headers = { "x-daou-session": "cookie-5" };
    const url = `${base}/bot/rooms/${encodeURIComponent("room:1")}/settings`;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await fetch(url, { headers })).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    const r = await fetch(url, { headers });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
    expect((await r.json()).error.code).toBe("rate_limited");
  });

  it("stores context only while autonomy is on", async () => {
    const store = new MemoryContextStore();
    await setup({ context: { store } });
    asMember();
    daou.msg("room:2", "before", { message_id: 1, ts: "2024-01-01T00:00:01.000Z" });
    await tick();
    expect(store.list("room:2")).toEqual([]);

    const r = await fetch(`${base}/bot/rooms/${encodeURIComponent("room:2")}/settings`, {
      method: "PUT", headers: { "x-daou-session": "ck", "content-type": "application/json" }, body: JSON.stringify({ autonomy: true }),
    });
    expect(r.status).toBe(200);
    daou.msg("room:2", "after", { message_id: 2, ts: "2024-01-01T00:00:02.000Z" });
    await tick();
    expect(store.list("room:2").map((m) => m.text)).toEqual(["after"]);

    const off = await fetch(`${base}/bot/rooms/${encodeURIComponent("room:2")}/settings`, {
      method: "PUT", headers: { "x-daou-session": "ck", "content-type": "application/json" }, body: JSON.stringify({ autonomy: false }),
    });
    expect(off.status).toBe(200);
    daou.msg("room:2", "after-off", { message_id: 3, ts: "2024-01-01T00:00:03.000Z" });
    await tick();
    expect(store.list("room:2").map((m) => m.text)).toEqual(["after"]);
  });

  it("does not post autonomy notices when disabled by option", async () => {
    const store = new MemoryContextStore();
    await setup({ context: { store, autonomyNotices: false } });
    asMember();
    const r = await fetch(`${base}/bot/rooms/${encodeURIComponent("room:9")}/settings`, {
      method: "PUT", headers: { "x-daou-session": "ck", "content-type": "application/json" }, body: JSON.stringify({ autonomy: true }),
    });
    expect((await r.json()).notice_sent).toBe(false);
    expect(daou.sends).toEqual([]);
  });

  it("still returns 200 when the autonomy notice fails", async () => {
    const store = new MemoryContextStore();
    await setup({ context: { store }, logger: () => {} });
    asMember();
    daou.failNext = true;
    const r = await fetch(`${base}/bot/rooms/${encodeURIComponent("room:9")}/settings`, {
      method: "PUT", headers: { "x-daou-session": "ck", "content-type": "application/json" }, body: JSON.stringify({ autonomy: true }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.notice_sent).toBe(false);
    expect(body.settings.autonomy).toBe(true);
    expect(store.getSettings("room:9").autonomy).toBe(true);
  });

  it("emits conversation_idle after N messages once idle, only to context:read clients", async () => {
    let now = Date.parse("2024-01-01T00:00:00.000Z");
    const store = new MemoryContextStore(() => now);
    store.setSettings("room:1", true, "test");
    await setup({ now: () => now, context: { store, idleMinMessages: 3, idleMs: 1000, idleCheckMs: 20 } });
    const withCtx = await connect(CTX), withoutCtx = await connect(RO);
    await tick(20);
    daou.msg("room:1", "a", { message_id: 1, ts: new Date(now).toISOString() });
    daou.msg("room:1", "b", { message_id: 2, ts: new Date(now + 10).toISOString() });
    now += 5000;
    await tick(80);
    expect(withCtx.got.filter((e) => e.type === "conversation_idle")).toEqual([]);

    daou.msg("room:1", "c", { message_id: 3, ts: new Date(now).toISOString() });
    now += 120_000;
    await tick(100);
    const ev = withCtx.got.find((e) => e.type === "conversation_idle");
    expect(ev).toMatchObject({
      room_id: "room:1", room_name: "A", message_count: 3, first_message_id: 1, last_message_id: 3,
      started_at: "2024-01-01T00:00:00.000Z", idle_minutes: 2,
    });
    expect(withoutCtx.got.some((e) => e.type === "conversation_idle")).toBe(false);
    withCtx.ws.close(); withoutCtx.ws.close();
  });

  it("does not track context or idle for rooms without autonomy", async () => {
    let now = Date.parse("2024-01-01T00:00:00.000Z");
    const store = new MemoryContextStore(() => now);
    await setup({ now: () => now, context: { store, idleMinMessages: 1, idleMs: 0, idleCheckMs: 20 } });
    const c = await connect(CTX);
    daou.msg("room:3", "a", { message_id: 1, ts: new Date(now).toISOString() });
    now += 60_000;
    await tick(80);
    expect(store.list("room:3")).toEqual([]);
    expect(c.got.filter((e) => e.type === "conversation_idle")).toEqual([]);
    c.ws.close();
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

const fileReq = (p: string, t = FULL) => fetch(`${base}${p}`, { headers: { authorization: `Bearer ${t}` } });
describe("inbound attachments and downloads", () => {
  it("enriches inbound file messages with BotAttachment metadata", async () => {
    await setup({ attachRetryMs: [0] });
    daou.attachments.set(1, [{ name: "보고서.pdf", size: 10, mime: "application/pdf", file_id: "crypt-1" }]);
    const c = await connect(FULL);
    daou.msg("room:1", "보고서.pdf", { messageType: "SENDFILE" }); await tick();
    const ev = c.got.find((e) => e.type === "message.created" && e.text === "보고서.pdf");
    expect(ev.message_id).toBe(1);
    expect(ev.attachments).toEqual([{ index: 0, name: "보고서.pdf", size: 10, mime: "application/pdf", file_id: "crypt-1", image: false, url: "/bot/files/1?index=0" }]);
    c.ws.close();
  });
  it("retries the REST attachment lookup when the first result is empty", async () => {
    await setup({ attachRetryMs: [0, 0] });
    daou.attachments.set(1, [{ name: "a.txt", size: 1, mime: "text/plain", file_id: "crypt-a" }]);
    daou.emptyLookups = 1;
    const c = await connect(FULL);
    daou.msg("room:1", "a.txt", { messageType: "SENDFILE" }); await tick();
    const ev = c.got.find((e) => e.type === "message.created");
    expect(ev.attachments).toHaveLength(1);
    expect(daou.attachmentLookups).toBeGreaterThanOrEqual(2);
    c.ws.close();
  });
  it("downloads exact bytes with mime.ts content-type, UTF-8 filename and one extra lookup", async () => {
    await setup({ attachRetryMs: [0] });
    const data = Buffer.from("download body", "utf8");
    daou.attachments.set(1, [{ name: "다운로드확인.txt", size: data.length, mime: "text/plain", file_id: "f1" }]);
    daou.binary.set("f1", { data, contentType: "application/x-upstream" });
    daou.msg("room:1", "다운로드확인.txt", { messageType: "SENDFILE" }); await tick();
    const lookups = daou.attachmentLookups;
    const r = await fileReq("/bot/files/1");
    expect(r.status).toBe(200);
    expect(Buffer.from(await r.arrayBuffer())).toEqual(data);
    expect(r.headers.get("content-type")).toBe("text/plain");
    expect(daou.attachmentLookups).toBe(lookups + 1);
    expect(r.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent("다운로드확인.txt")}`);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(srv.audit.entries).toContainEqual(expect.objectContaining({ action: "file_download", token_id: "hermes", room_id: "room:1", message_id: 1, file_name: "다운로드확인.txt", file_size: data.length, status: "ok" }));
  });
  it("requires a token and the files or events scope", async () => {
    await setup();
    expect((await fetch(`${base}/bot/files/1`)).status).toBe(401);
    const r = await fileReq("/bot/files/1", ROOMS);
    expect(r.status).toBe(403); expect((await r.json()).error.code).toBe("forbidden_scope");
  });
  it("rejects non-allowlisted rooms and missing attachments", async () => {
    await setup();
    const denied = await fileReq("/bot/files/1?room_id=room:2");
    expect(denied.status).toBe(404);
    const missing = await fileReq("/bot/files/999?room_id=room:1");
    expect(missing.status).toBe(404); expect((await missing.json()).error.code).toBe("not_found");
  });
  it("only ids delivered to the adapter (or stored from autonomy rooms) are downloadable", async () => {
    const store = new MemoryContextStore();
    await setup({ attachRetryMs: [0], context: { store } } as any);
    const data = Buffer.from("published", "utf8");
    daou.attachments.set(50, [{ name: "a.txt", size: data.length, mime: "text/plain", file_id: "f50" }]);
    daou.binary.set("f50", { data });
    expect((await fileReq("/bot/files/50", RO)).status).toBe(404);
    expect((await fileReq("/bot/files/50?room_id=room:1", FULL)).status).toBe(404); // explicit room no longer enough
    daou.msg("room:1", "a.txt", { message_id: 50, messageType: "SENDFILE" });
    await tick();
    const published = await fileReq("/bot/files/50", RO);
    expect(published.status).toBe(200);
    expect(Buffer.from(await published.arrayBuffer())).toEqual(data);
    expect(store.deliveredRoom(50)).toBe("room:1"); // persisted proof survives restarts
    // autonomy room not in BOT_ROOMS: stored message is downloadable with explicit room_id
    store.setSettings("room:9", true, "test");
    daou.attachments.set(51, [{ name: "b.txt", size: 1, mime: "text/plain", file_id: "f51" }]);
    daou.binary.set("f51", { data: Buffer.from("b") });
    daou.msg("room:9", "b.txt", { message_id: 51, messageType: "SENDFILE" });
    await tick();
    expect((await fileReq("/bot/files/51?room_id=room:9", FULL)).status).toBe(404); // no context:read
    expect((await fileReq("/bot/files/51?room_id=room:9", CTX)).status).toBe(200);
    expect((await fileReq("/bot/files/51?room_id=room:2", FULL)).status).toBe(404);
  });
  it("does not remember ids filtered out by mention-only", async () => {
    await setup({ mentionOnly: true, attachRetryMs: [0] });
    const data = Buffer.from("hidden", "utf8");
    daou.attachments.set(60, [{ name: "a.txt", size: data.length, mime: "text/plain", file_id: "f60" }]);
    daou.binary.set("f60", { data });
    daou.msg("room:1", "a.txt", { message_id: 60, messageType: "SENDFILE" });
    await tick();
    expect((await fileReq("/bot/files/60", RO)).status).toBe(404);
  });
  it("rate limits /bot/files per token with retry-after", async () => {
    await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await fileReq("/bot/files/999?room_id=room:1")).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(404));
    expect(statuses[10]).toBe(429);
    const r = await fileReq("/bot/files/999?room_id=room:1");
    expect(r.status).toBe(429); expect(r.headers.get("retry-after")).toBeTruthy();
    expect((await r.json()).error.code).toBe("rate_limited");
  });
  it("rejects files larger than maxFileBytes (metadata and streamed cap)", async () => {
    await setup({ maxFileBytes: 4, attachRetryMs: [0] });
    daou.attachments.set(7, [{ name: "big.bin", size: 100, mime: "application/octet-stream", file_id: "big" }]);
    daou.binary.set("big", { data: Buffer.alloc(100, 1) });
    daou.msg("room:1", "big.bin", { message_id: 7, messageType: "SENDFILE" }); await tick();
    const r = await fileReq("/bot/files/7");
    expect(r.status).toBe(413); expect((await r.json()).error.code).toBe("too_large");
    daou.attachments.set(8, [{ name: "lie.bin", file_id: "lie" }]);
    daou.binary.set("lie", { data: Buffer.alloc(100, 1) });
    daou.msg("room:1", "lie.bin", { message_id: 8, messageType: "SENDFILE" }); await tick();
    expect((await fileReq("/bot/files/8")).status).toBe(413);
  });
  it("extracts text from a txt attachment", async () => {
    await setup({ attachRetryMs: [0] });
    const data = Buffer.from("hello\nworld", "utf8");
    daou.attachments.set(1, [{ name: "a.txt", size: data.length, mime: "text/plain", file_id: "t1" }]);
    daou.binary.set("t1", { data, contentType: "text/plain" });
    daou.msg("room:1", "a.txt", { messageType: "SENDFILE" }); await tick();
    const r = await fileReq("/bot/files/1/text");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ message_id: 1, index: 0, name: "a.txt", mime: "text/plain", chars: 11, truncated: false, text: "hello\nworld" });
    expect(srv.audit.entries).toContainEqual(expect.objectContaining({ action: "file_text", token_id: "hermes", room_id: "room:1", message_id: 1, file_name: "a.txt", status: "ok" }));
  });
});

const hasPython = (() => { try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
describe("extract", () => {
  it("strips pathological '<' input in linear time", () => {
    const input = "<".repeat(500_000) + ">" + "hello";
    const start = Date.now();
    expect(stripTags(input)).toBe("hello");
    expect(Date.now() - start).toBeLessThan(1000);
  });
  (hasPython ? it : it.skip)("extracts docx text built by python zipfile", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ubm-docx-"));
    const file = path.join(dir, "a.docx");
    try {
      const script = [
        "import sys, zipfile",
        "xml = '<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>World &amp; more</w:t></w:r></w:p></w:body></w:document>'",
        "with zipfile.ZipFile(sys.argv[1], 'w') as z:",
        "    z.writestr('word/document.xml', xml)",
      ].join("\n");
      execFileSync("python3", ["-c", script, file]);
      const res = await extractText("a.docx", fs.readFileSync(file));
      expect(res.text).toContain("Hello");
      expect(res.text).toContain("World & more");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  (hasPython ? it : it.skip)("refuses zip bombs before inflating (declared uncompressed > 100MB)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ubm-bomb-"));
    const file = path.join(dir, "b.docx");
    try {
      execFileSync("python3", ["-c", "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:\n  z.writestr('word/document.xml', b'\\0'*(101*1024*1024))", file]);
      await expect(extractText("b.docx", fs.readFileSync(file))).rejects.toMatchObject({ code: "archive_too_large", status: 413 });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);
  (hasPython ? it : it.skip)("pptx with many unclosed <a:t> tags extracts in linear time", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ubm-pptx-"));
    const file = path.join(dir, "p.pptx");
    try {
      execFileSync("python3", ["-c", "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:\n  z.writestr('ppt/slides/slide1.xml', '<a:t>ok</a:t>' + '<a:t>'*400000)", file]);
      const t0 = Date.now();
      const res = await extractText("p.pptx", fs.readFileSync(file));
      expect(res.text).toContain("ok");
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);
});
