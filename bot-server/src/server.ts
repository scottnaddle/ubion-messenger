import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import WebSocket, { WebSocketServer } from "ws";
import { Allowlist, hasScope, TokenStore, type TokenRecord } from "./auth";
import { Audit } from "./audit";
import { EventLog } from "./events";
import { RateLimiter } from "./ratelimit";
import { MultipartError, multipartBoundary, parseMultipart, sanitizeFilename, type MultipartResult } from "./multipart";
import type { BotEvent, BotRoom, DaouPort } from "./types";

export type BotServerOpts = {
  port: DaouPort; tokens: TokenStore; allowlist: Allowlist; mentionOnly?: boolean;
  heartbeatMs?: number; sendRate?: { cap: number; perSec: number }; roomRate?: { cap: number; perSec: number };
  audit?: Audit; maxTextLen?: number; maxFileBytes?: number; now?: () => number;
  statusThrottleMs?: number; placeholderTtlMs?: number; logger?: (m: string) => void;
};
type Err = { status: number; code: string; message: string };
const E = (status: number, code: string, message: string): Err => ({ status, code, message });

export class BotServer {
  readonly http: http.Server;
  readonly log = new EventLog();
  readonly audit: Audit;
  private wss = new WebSocketServer({ noServer: true });
  private clients = new Set<{ ws: WebSocket; tok: TokenRecord }>();
  private sent = new Map<string, { at: number; body: unknown; status: number }>();
  private inflight = new Map<string, Promise<{ status: number; body: unknown }>>();
  private sendRl: RateLimiter; private roomRl: RateLimiter;
  private roomNames = new Map<string, string>();
  private ph = new Map<string, { id: number; timer: NodeJS.Timeout }>();
  private lastStatus = new Map<string, number>();
  private hb: NodeJS.Timeout | null = null; private offs: Array<() => void> = [];

  constructor(private o: BotServerOpts) {
    this.audit = o.audit ?? new Audit();
    const now = o.now ?? Date.now;
    this.sendRl = new RateLimiter(o.sendRate?.cap ?? 10, o.sendRate?.perSec ?? 1, now);
    this.roomRl = new RateLimiter(o.roomRate?.cap ?? 5, o.roomRate?.perSec ?? 0.5, now);
    this.http = http.createServer((q, s) => this.route(q, s).catch(() => this.json(s, 500, { error: { code: "internal", message: "internal error" } })));
    this.http.on("upgrade", (req, sock, head) => this.upgrade(req, sock, head));
    this.offs.push(o.port.onMessage((m) => {
      if (m.is_mine || !o.allowlist.allows(m.room_id)) return;
      if (m.message_id) void o.port.markRead?.(m.room_id, m.message_id).catch(() => {});
      const me = o.port.botUserId();
      if (o.mentionOnly && !m.room_id.startsWith("buddy:") && !(me && m.mentions.includes(me)) && !m.text.includes(`@${o.port.botName()}`)) return;
      this.publish({ type: "message.created", event_id: this.log.nextId(), room_id: m.room_id, room_name: this.roomNames.get(m.room_id) ?? "", sender: m.sender, text: m.text, mentions: m.mentions, attachments: m.attachments, reply_to: m.reply_to, ts: m.ts });
    }));
    this.offs.push(o.port.onRoomJoined((r) => {
      this.roomNames.set(r.room_id, r.room_name);
      if (o.allowlist.allows(r.room_id)) this.publish({ type: "room.joined", event_id: this.log.nextId(), room_id: r.room_id, room_name: r.room_name, ts: new Date().toISOString() });
    }));
    this.hb = setInterval(() => this.broadcastRaw({ type: "heartbeat", ts: new Date().toISOString(), last_event_id: this.lastId() }), o.heartbeatMs ?? 25_000);
    this.hb.unref();
  }

  listen(p: number, host = "127.0.0.1") { return new Promise<number>((r) => this.http.listen(p, host, () => r((this.http.address() as any).port))); }
  async close() { for (const p of this.ph.values()) clearTimeout(p.timer); this.ph.clear(); this.offs.forEach((f) => f()); if (this.hb) clearInterval(this.hb); for (const c of this.clients) c.ws.terminate(); this.wss.close(); await new Promise((r) => this.http.close(r)); }
  private lastId() { const l = this.log.after("0"); return l && l.length ? l[l.length - 1].event_id : "0"; }

  private publish(ev: BotEvent) {
    this.log.push(ev);
    for (const c of this.clients) if (hasScope(c.tok, "events:read") && this.o.allowlist.allows(ev.room_id, c.tok)) this.sendWs(c.ws, ev);
  }
  private broadcastRaw(x: unknown) { for (const c of this.clients) this.sendWs(c.ws, x); }
  private sendWs(ws: WebSocket, x: unknown) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(x)); }

  private upgrade(req: http.IncomingMessage, sock: any, head: Buffer) {
    const url = new URL(req.url || "/", "http://x");
    const tok = this.o.tokens.verify(req.headers.authorization);
    if (url.pathname !== "/bot/ws" || !tok || !hasScope(tok, "events:read")) {
      sock.write(`HTTP/1.1 ${tok ? 403 : 401} ${tok ? "Forbidden" : "Unauthorized"}\r\nConnection: close\r\n\r\n`); sock.destroy(); return;
    }
    this.wss.handleUpgrade(req, sock, head, (ws) => {
      const c = { ws, tok }; this.clients.add(c);
      this.audit.log({ action: "ws.connect", token_id: tok.id, status: "ok" });
      ws.on("close", () => this.clients.delete(c));
      const after = url.searchParams.get("after");
      this.sendWs(ws, { type: "hello", last_event_id: this.lastId() });
      if (after != null) {
        const back = this.log.after(after);
        if (back === null) this.sendWs(ws, { type: "resume.gap", after, last_event_id: this.lastId() });
        else for (const ev of back) if (this.o.allowlist.allows(ev.room_id, tok)) this.sendWs(ws, ev);
      }
    });
  }

  private json(s: http.ServerResponse, st: number, b: unknown, h: Record<string, string> = {}) { s.writeHead(st, { "content-type": "application/json", ...h }); s.end(JSON.stringify(b)); }
  private fail(s: http.ServerResponse, e: Err, h: Record<string, string> = {}) { this.json(s, e.status, { error: { code: e.code, message: e.message } }, h); }

  private async route(q: http.IncomingMessage, s: http.ServerResponse) {
    const path = new URL(q.url || "/", "http://x").pathname;
    if (q.method === "GET" && path === "/bot/health") return this.json(s, 200, { ok: true, daou: this.o.port.healthy().state, ws_clients: this.clients.size, last_event_id: this.lastId() });
    const tok = this.o.tokens.verify(q.headers.authorization);
    if (!tok) return this.fail(s, E(401, "unauthorized", "missing or invalid bearer token"));
    if (q.method === "GET" && path === "/bot/rooms") {
      if (!hasScope(tok, "rooms:read")) return this.fail(s, E(403, "forbidden_scope", "rooms:read required"));
      const rooms: BotRoom[] = (await this.o.port.listRooms()).filter((r) => { this.roomNames.set(r.room_id, r.room_name); return this.o.allowlist.allows(r.room_id, tok); });
      return this.json(s, 200, { rooms });
    }
    if (q.method === "POST" && path === "/bot/send") {
      if (!hasScope(tok, "messages:send")) return this.fail(s, E(403, "forbidden_scope", "messages:send required"));
      let b: any; try { b = JSON.parse(await readBody(q, 64 * 1024)); } catch { return this.fail(s, E(400, "bad_request", "invalid JSON body")); }
      const r = await this.send(tok, b);
      return this.json(s, r.status, r.body, r.status === 429 ? { "retry-after": String((r.body as any).error.retry_after_s) } : {});
    }
    if (q.method === "POST" && path === "/bot/send-file") {
      if (!hasScope(tok, "messages:send")) return this.fail(s, E(403, "forbidden_scope", "messages:send required"));
      const r = await this.sendFile(tok, q);
      return this.json(s, r.status, r.body, r.headers ?? {});
    }
    if (q.method === "POST" && path === "/bot/status") {
      if (!hasScope(tok, "messages:send")) return this.fail(s, E(403, "forbidden_scope", "messages:send required"));
      let b: any; try { b = JSON.parse(await readBody(q, 16 * 1024)); } catch { return this.fail(s, E(400, "bad_request", "invalid JSON body")); }
      const r = await this.status(tok, b);
      return this.json(s, r.status, r.body);
    }
    return this.fail(s, E(404, "not_found", "no such endpoint"));
  }

  async send(tok: TokenRecord, b: any): Promise<{ status: number; body: unknown }> {
    const err = (e: Err, extra: object = {}) => ({ status: e.status, body: { error: { code: e.code, message: e.message, ...extra } } });
    if (!b || typeof b.room_id !== "string" || typeof b.text !== "string" || typeof b.client_msg_id !== "string" || !b.client_msg_id || b.client_msg_id.length > 128)
      return err(E(400, "bad_request", "room_id, text, client_msg_id (string) required"));
    if (!b.text.trim() || b.text.length > (this.o.maxTextLen ?? 4000)) return err(E(400, "bad_text", "text empty or too long"));
    if (!this.o.allowlist.allows(b.room_id, tok)) { this.audit.log({ action: "send", token_id: tok.id, room_id: b.room_id, client_msg_id: b.client_msg_id, status: "denied", code: "room_not_allowed" }); return err(E(403, "room_not_allowed", "room is not allowlisted")); }
    const key = `${tok.id}:${b.client_msg_id}`;
    const done = this.sent.get(key); if (done) return { status: done.status, body: { ...(done.body as object), duplicate: true } };
    const fl = this.inflight.get(key); if (fl) return fl.then((r) => ({ ...r, body: { ...(r.body as object), duplicate: true } }));
    for (const [k, rk] of [[tok.id, this.sendRl], [b.room_id, this.roomRl]] as const) {
      const t = rk.take(k);
      if (!t.ok) { this.audit.log({ action: "send", token_id: tok.id, room_id: b.room_id, client_msg_id: b.client_msg_id, status: "limited", code: "rate_limited" }); return err(E(429, "rate_limited", "slow down"), { retry_after_s: Math.ceil(t.retryAfterMs / 1000) }); }
    }
    const text = b.text; // DaouOffice has no native reply; reply_to is accepted and audited only (spec §5.3)
    const p = (async () => {
      try {
        const r = await this.o.port.sendText(b.room_id, text);
        const out = { status: 200, body: { ok: true, message_id: r.message_id ?? null, client_msg_id: b.client_msg_id } };
        this.sent.set(key, { at: Date.now(), ...out }); this.gc();
        this.audit.log({ action: "send", token_id: tok.id, room_id: b.room_id, client_msg_id: b.client_msg_id, status: "ok" });
        await this.clearPlaceholder(b.room_id, tok.id, "send");
        return out;
      } catch {
        this.audit.log({ action: "send", token_id: tok.id, room_id: b.room_id, client_msg_id: b.client_msg_id, status: "error", code: "upstream_error" });
        return err(E(502, "upstream_error", "DaouOffice send failed; safe to retry with same client_msg_id"));
      } finally { this.inflight.delete(key); }
    })();
    this.inflight.set(key, p); return p;
  }
  async sendFile(tok: TokenRecord, q: http.IncomingMessage): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
    const err = (e: Err, extra: object = {}) => ({ status: e.status, body: { error: { code: e.code, message: e.message, ...extra } } });
    const boundary = multipartBoundary(q.headers["content-type"]);
    if (!boundary) { q.resume(); return err(E(400, "bad_request", "multipart/form-data required")); }
    const maxBytes = this.o.maxFileBytes ?? 20 * 1024 * 1024;
    let dir: string | null = null;
    try {
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ubm-upload-"));
      let parsed: MultipartResult;
      try {
        parsed = await parseMultipart(q, { boundary, dir, maxBytes });
      } catch (e) {
        if (e instanceof MultipartError && e.code === "payload_too_large") {
          this.audit.log({ action: "send_file", token_id: tok.id, status: "error", code: "payload_too_large" });
          return err(E(413, "payload_too_large", "request body exceeds maxFileBytes"));
        }
        if (e instanceof MultipartError) return err(E(400, "bad_request", e.message));
        throw e;
      }
      const room_id = parsed.fields.room_id;
      if (!room_id) return err(E(400, "bad_request", "room_id required"));
      if (!parsed.file) return err(E(400, "bad_request", "file required"));
      const name = sanitizeFilename(parsed.file.name);
      if (!name) return err(E(400, "bad_request", "file name required"));
      const fileSize = parsed.file.size;
      if (!this.o.allowlist.allows(room_id, tok)) {
        this.audit.log({ action: "send_file", token_id: tok.id, room_id, file_name: name, file_size: fileSize, status: "denied", code: "room_not_allowed" });
        return err(E(403, "room_not_allowed", "room is not allowlisted"));
      }
      for (const [k, rk] of [[tok.id, this.sendRl], [room_id, this.roomRl]] as const) {
        const t = rk.take(k);
        if (!t.ok) {
          this.audit.log({ action: "send_file", token_id: tok.id, room_id, file_name: name, file_size: fileSize, status: "limited", code: "rate_limited" });
          const retry_after = String(Math.ceil(t.retryAfterMs / 1000));
          return { status: 429, body: { error: { code: "rate_limited", message: "slow down", retry_after_s: Number(retry_after) } }, headers: { "retry-after": retry_after } };
        }
      }
      const data = await fs.promises.readFile(parsed.file.path);
      let r: { message_id?: number };
      try {
        if (!this.o.port.sendFile) throw new Error("sendFile unsupported");
        r = await this.o.port.sendFile(room_id, { name, data, mime: parsed.file.mime });
      } catch {
        this.audit.log({ action: "send_file", token_id: tok.id, room_id, file_name: name, file_size: fileSize, status: "error", code: "upstream_error" });
        return err(E(502, "upstream_error", "DaouOffice file send failed"));
      }
      let text_message_id: number | null = null;
      let text_error = false;
      const text = parsed.fields.text ?? "";
      if (text.trim()) {
        try {
          const tr = await this.o.port.sendText(room_id, text);
          text_message_id = tr.message_id ?? null;
        } catch { text_error = true; }
      }
      await this.clearPlaceholder(room_id, tok.id, "send_file");
      this.audit.log({ action: "send_file", token_id: tok.id, room_id, file_name: name, file_size: fileSize, status: "ok", ...(text_error ? { code: "text_error" } : {}) });
      const body: Record<string, unknown> = { ok: true, message_id: r.message_id ?? null, text_message_id, file: { name, size: data.length } };
      if (text_error) body.text_error = true;
      return { status: 200, body };
    } finally {
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private logf(m: string) { try { (this.o.logger ?? ((x: string) => console.error(`[bot-status] ${x}`)))(m); } catch { /* ignore */ } }
  /** Delete the room's placeholder (if any). Never throws. */
  private async clearPlaceholder(room_id: string, token_id: string, reason: string): Promise<boolean> {
    const p = this.ph.get(room_id); if (!p) return false;
    this.ph.delete(room_id); clearTimeout(p.timer);
    try {
      if (!this.o.port.deleteMessages) throw new Error("port has no deleteMessages");
      await this.o.port.deleteMessages(room_id, [p.id]);
      this.audit.log({ action: "status.delete", token_id, room_id, status: "ok", code: reason });
      return true;
    } catch (e: any) {
      this.logf(`placeholder delete failed room=${room_id} reason=${reason} err=${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 120)}`);
      this.audit.log({ action: "status.delete", token_id, room_id, status: "error", code: reason });
      return false;
    }
  }

  async status(tok: TokenRecord, b: any): Promise<{ status: number; body: unknown }> {
    const err = (e: Err) => ({ status: e.status, body: { error: { code: e.code, message: e.message } } });
    try {
      if (!b || typeof b.room_id !== "string" || !["thinking", "working", "done"].includes(b.state)) return err(E(400, "bad_request", "room_id and state (thinking|working|done) required"));
      if (b.text != null && typeof b.text !== "string") return err(E(400, "bad_request", "text must be a string"));
      if (!this.o.allowlist.allows(b.room_id, tok)) { this.audit.log({ action: "status", token_id: tok.id, room_id: b.room_id, status: "denied", code: "room_not_allowed" }); return err(E(403, "room_not_allowed", "room not allowlisted")); }
      const now = (this.o.now ?? Date.now)(), gap = this.o.statusThrottleMs ?? 3000;
      const last = this.lastStatus.get(b.room_id);
      if (last != null && now - last < gap) { this.audit.log({ action: "status", token_id: tok.id, room_id: b.room_id, status: "throttled", code: b.state }); return { status: 200, body: { ok: true, throttled: true, state: b.state } }; }
      this.lastStatus.set(b.room_id, now);
      if (b.state === "done") {
        const deleted = await this.clearPlaceholder(b.room_id, tok.id, "done");
        this.audit.log({ action: "status", token_id: tok.id, room_id: b.room_id, status: "ok", code: "done" });
        return { status: 200, body: { ok: true, state: "done", deleted } };
      }
      let text = "💭 생각 중…";
      if (b.state === "working") {
        const t = String(b.text ?? "").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, " ").replace(/\s+/g, " ").trim();
        text = t ? `⚙️ ${[...t].slice(0, 60).join("")}` : "⚙️ 작업 중…";
      }
      let r: { message_id?: number };
      try { r = await this.o.port.sendText(b.room_id, text); }
      catch (e: any) {
        this.logf(`placeholder send failed room=${b.room_id} err=${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 120)}`);
        this.audit.log({ action: "status", token_id: tok.id, room_id: b.room_id, status: "error", code: "upstream_error" });
        return err(E(502, "upstream_error", "DaouOffice send failed"));
      }
      await this.clearPlaceholder(b.room_id, tok.id, "replace");
      const id = Number(r?.message_id);
      if (Number.isFinite(id) && id > 0) {
        const timer = setTimeout(() => { void this.clearPlaceholder(b.room_id, tok.id, "expired"); }, this.o.placeholderTtlMs ?? 600_000);
        timer.unref?.(); this.ph.set(b.room_id, { id, timer });
      } else this.logf(`placeholder sent without message_id room=${b.room_id}; cannot auto-delete`);
      this.audit.log({ action: "status", token_id: tok.id, room_id: b.room_id, status: "ok", code: b.state });
      return { status: 200, body: { ok: true, state: b.state, message_id: Number.isFinite(id) && id > 0 ? id : null } };
    } catch (e: any) {
      this.logf(`status handler error: ${String(e?.message ?? e).slice(0, 120)}`);
      return err(E(500, "internal", "internal error"));
    }
  }
  private gc() { const cut = Date.now() - 24 * 3600_000; for (const [k, v] of this.sent) if (v.at < cut) this.sent.delete(k); else break; }
}

function readBody(q: http.IncomingMessage, max: number) {
  return new Promise<string>((res, rej) => { let n = 0; const ch: Buffer[] = []; q.on("data", (c: Buffer) => { n += c.length; if (n > max) { rej(new Error("too large")); q.destroy(); } else ch.push(c); }); q.on("end", () => res(Buffer.concat(ch).toString("utf8"))); q.on("error", rej); });
}
