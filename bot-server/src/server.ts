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
import type { BotAttachment, BotEvent, BotRoom, DaouPort, InboundMessage } from "./types";
import type { ContextStore, RoomSettings, StoredAttachment } from "./context";
import { mimeFor } from "./mime";
import { ExtractError, extractText } from "./extract";

export type ContextOpts = {
  store: ContextStore; retentionDays?: number;
  idleMinMessages?: number; idleMs?: number; idleCheckMs?: number;
  autonomyNotices?: boolean;
};

export type BotServerOpts = {
  port: DaouPort; tokens: TokenStore; allowlist: Allowlist; mentionOnly?: boolean;
  heartbeatMs?: number; sendRate?: { cap: number; perSec: number }; roomRate?: { cap: number; perSec: number };
  audit?: Audit; maxTextLen?: number; maxFileBytes?: number; now?: () => number;
  statusThrottleMs?: number;
  /** Peers whose X-Forwarded-For is trusted (reverse proxy). Default 127.0.0.1 and ::1. */
  trustedProxies?: string[];
  /** Browser origins allowed for CORS on the settings endpoints (empty = no CORS headers). */
  corsOrigins?: string[]; placeholderTtlMs?: number; statusMode?: "message" | "chatstate"; attachRetryMs?: number[]; logger?: (m: string) => void;
  context?: ContextOpts; autonomyNotices?: boolean;
};

const AUTONOMY_ON_NOTICE = "유비온봇 자율활동이 켜졌습니다. 이 방의 대화를 기록하고, 대화가 끝나면 정리해 드립니다. (끄기: 방 설정 > 유비온봇 자율활동)";
const AUTONOMY_OFF_NOTICE = "유비온봇 자율활동이 꺼졌습니다. 이제 이 방의 대화를 기록하지 않습니다. (멘션하면 계속 답합니다)";

type IdleState = { count: number; first_message_id: number; last_message_id: number; first_ts: string; last_ts: string; last_at: number };

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_res, rej) => {
    timer = setTimeout(() => rej(new Error("timeout")), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer!));
}

type AttachmentMeta = { name: string; size?: number; mime?: string; file_id: string; image?: boolean };
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
  private noticeAt = new Map<string, number>();
  private sendRl: RateLimiter; private roomRl: RateLimiter; private fileRl: RateLimiter; private humanRl: RateLimiter;
  private roomNames = new Map<string, string>();
  private ph = new Map<string, { id: number; timer: NodeJS.Timeout }>();
  private lastStatus = new Map<string, number>();
  private messageRooms = new Map<number, string>();
  private inboundChain: Promise<void> = Promise.resolve();
  private hb: NodeJS.Timeout | null = null; private offs: Array<() => void> = [];
  private now: () => number;
  private ctx?: ContextOpts;
  private idle = new Map<string, IdleState>();
  private idleTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(private o: BotServerOpts) {
    this.audit = o.audit ?? new Audit();
    this.now = o.now ?? Date.now;
    const now = this.now;
    this.ctx = o.context;
    this.sendRl = new RateLimiter(o.sendRate?.cap ?? 10, o.sendRate?.perSec ?? 1, now);
    this.roomRl = new RateLimiter(o.roomRate?.cap ?? 5, o.roomRate?.perSec ?? 0.5, now);
    this.fileRl = new RateLimiter(10, 1, now);
    this.humanRl = new RateLimiter(10, 0.2, now);
    this.http = http.createServer((q, s) => this.route(q, s).catch(() => this.json(s, 500, { error: { code: "internal", message: "internal error" } })));
    this.http.on("upgrade", (req, sock, head) => this.upgrade(req, sock, head));
    this.offs.push(o.port.onMessage((m) => {
      if (this.isContextRoom(m.room_id)) this.storeContext(m);
      if (m.is_mine || !o.allowlist.allows(m.room_id)) return;
      if (m.message_id) void o.port.markRead?.(m.room_id, m.message_id).catch(() => {});
      const me = o.port.botUserId();
      if (o.mentionOnly && !m.room_id.startsWith("buddy:") && !(me && m.mentions.includes(me)) && !m.text.includes(`@${o.port.botName()}`)) return;
      if (m.message_id) this.rememberMessage(m.message_id, m.room_id);
      const event_id = this.log.nextId();
      this.inboundChain = this.inboundChain.then(() => this.publishInbound(m, event_id)).catch(() => {});
    }));
    this.offs.push(o.port.onRoomJoined((r) => {
      this.roomNames.set(r.room_id, r.room_name);
      if (o.allowlist.allows(r.room_id)) {
        const event_id = this.log.nextId();
        this.inboundChain = this.inboundChain.then(() => this.publish({ type: "room.joined", event_id, room_id: r.room_id, room_name: r.room_name, ts: new Date().toISOString() })).catch(() => {});
      }
    }));
    this.hb = setInterval(() => this.broadcastRaw({ type: "heartbeat", ts: new Date().toISOString(), last_event_id: this.lastId() }), o.heartbeatMs ?? 25_000);
    this.hb.unref();
    if (this.ctx) {
      this.pruneContext();
      this.pruneTimer = setInterval(() => this.pruneContext(), 3600_000);
      this.pruneTimer.unref();
      this.idleTimer = setInterval(() => this.checkIdle(), this.ctx.idleCheckMs ?? 60_000);
      this.idleTimer.unref();
      void o.port.listRooms().then((rooms) => { for (const r of rooms) this.roomNames.set(r.room_id, r.room_name); }).catch(() => {});
    }
  }

  listen(p: number, host = "127.0.0.1") { return new Promise<number>((r) => this.http.listen(p, host, () => r((this.http.address() as any).port))); }
  async close() {
    for (const p of this.ph.values()) clearTimeout(p.timer); this.ph.clear();
    this.offs.forEach((f) => f()); if (this.hb) clearInterval(this.hb);
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    for (const c of this.clients) c.ws.terminate(); this.wss.close(); await new Promise((r) => this.http.close(r));
  }
  private lastId() { const l = this.log.after("0"); return l && l.length ? l[l.length - 1].event_id : "0"; }

  private isContextRoom(room_id: string): boolean {
    const c = this.ctx;
    if (!c) return false;
    try { return c.store.getSettings(room_id).autonomy; } catch { return false; }
  }

  private storeContext(m: InboundMessage): void {
    this.trackIdle(m);
    void this.persistContext(m);
  }

  private async persistContext(m: InboundMessage): Promise<void> {
    const c = this.ctx;
    if (!c) return;
    let source = Array.isArray(m.attachments) ? m.attachments : [];
    if (looksLikeFile(m) && this.o.allowlist.allows(m.room_id) && this.o.port.getAttachments) {
      const missingIds = source.length === 0 || source.some((a) => !a.file_id);
      if (missingIds) {
        let fetched: AttachmentMeta[] = [];
        try { fetched = await this.fetchAttachmentsWithRetry(m.room_id, m.message_id); } catch { /* keep known attachments */ }
        if (fetched.length) source = fetched.map((a) => ({ name: a.name, size: a.size, type: a.mime, file_id: a.file_id, image: a.image }));
      }
    }
    const attachments: StoredAttachment[] = source.map((a, index) => ({
      index,
      name: a.name || "file",
      size: typeof a.size === "number" ? a.size : null,
      mime: a.type && a.type.includes("/") ? a.type : mimeFor(a.name || "file"),
      file_id: a.file_id ?? "",
    }));
    try {
      c.store.add({
        room_id: m.room_id, message_id: m.message_id,
        sender_id: m.sender?.id ?? "", sender_name: m.sender?.name ?? "",
        ts: Number.isFinite(Date.parse(m.ts)) ? new Date(Date.parse(m.ts)).toISOString() : new Date(this.now()).toISOString(), text: m.text ?? "", attachments, is_mine: !!m.is_mine,
      });
    } catch { /* context must never break the message path */ }
  }

  private trackIdle(m: InboundMessage): void {
    if (m.is_mine) return;
    const now = this.now();
    const parsed = Date.parse(m.ts);
    const at = Number.isFinite(parsed) ? parsed : now;
    const prev = this.idle.get(m.room_id);
    if (!prev) {
      this.idle.set(m.room_id, {
        count: 1, first_message_id: m.message_id, last_message_id: m.message_id,
        first_ts: m.ts, last_ts: m.ts, last_at: at,
      });
      return;
    }
    prev.count++;
    prev.last_message_id = m.message_id;
    prev.last_ts = m.ts;
    prev.last_at = at;
  }

  private checkIdle(): void {
    const c = this.ctx;
    if (!c) return;
    const now = this.now();
    const min = c.idleMinMessages ?? 5;
    const idleMs = c.idleMs ?? 20 * 60_000;
    for (const [room_id, st] of this.idle) {
      if (!this.isContextRoom(room_id)) { this.idle.delete(room_id); continue; }
      if (st.count < min || now - st.last_at < idleMs) continue;
      const event_id = this.log.nextId();
      const ev: BotEvent = {
        type: "conversation_idle", event_id, room_id, room_name: this.roomNames.get(room_id) ?? "",
        message_count: st.count, first_message_id: st.first_message_id, last_message_id: st.last_message_id,
        started_at: st.first_ts, ended_at: st.last_ts, idle_minutes: Math.max(0, Math.floor((now - st.last_at) / 60_000)),
      };
      this.log.push(ev);
      for (const client of this.clients) {
        if (hasScope(client.tok, "events:read") && hasScope(client.tok, "context:read") && (!client.tok.rooms || client.tok.rooms.includes(room_id)))
          this.sendWs(client.ws, ev);
      }
      this.idle.delete(room_id);
    }
  }

  private pruneContext(): void {
    const c = this.ctx;
    if (!c) return;
    const days = c.retentionDays ?? 90;
    if (!Number.isFinite(days) || days < 0) return;
    try { c.store.prune(days * 24 * 3600_000); } catch { /* best effort */ }
  }

  private rememberMessage(message_id: number, room_id: string) {
    if (!message_id) return;
    if (this.messageRooms.has(message_id)) this.messageRooms.delete(message_id);
    this.messageRooms.set(message_id, room_id);
    try { this.ctx?.store.markDelivered(room_id, message_id); } catch { /* best effort */ }
    while (this.messageRooms.size > 2000) {
      const first = this.messageRooms.keys().next();
      if (first.done) break;
      this.messageRooms.delete(first.value);
    }
  }

  private async publishInbound(m: InboundMessage, event_id: string) {
    let source = Array.isArray(m.attachments) ? m.attachments : [];
    const missingIds = source.length === 0 || source.some((a) => !a.file_id);
    if (missingIds && looksLikeFile(m) && this.o.port.getAttachments) {
      let fetched: AttachmentMeta[] = [];
      try { fetched = await this.fetchAttachmentsWithRetry(m.room_id, m.message_id); } catch { /* keep known attachments */ }
      if (fetched.length) source = fetched.map((a) => ({ name: a.name, size: a.size, type: a.mime, file_id: a.file_id, image: a.image }));
    }
    const attachments: BotAttachment[] = source.map((a, index) => ({
      index,
      name: a.name || "file",
      size: typeof a.size === "number" ? a.size : null,
      mime: a.type && a.type.includes("/") ? a.type : mimeFor(a.name || "file"),
      file_id: a.file_id ?? "",
      image: !!a.image,
      url: `/bot/files/${m.message_id}?index=${index}`,
    }));
    this.publish({ type: "message.created", event_id, room_id: m.room_id, room_name: this.roomNames.get(m.room_id) ?? "", message_id: m.message_id, sender: m.sender, text: m.text, mentions: m.mentions, attachments, reply_to: m.reply_to, ts: m.ts });
  }

  private async fetchAttachmentsWithRetry(room_id: string, message_id: number): Promise<AttachmentMeta[]> {
    const port = this.o.port;
    const get = port.getAttachments;
    if (!get) return [];
    const delays = this.o.attachRetryMs ?? [0, 500, 1000, 2000];
    const deadline = Date.now() + 10_000;
    for (const raw of delays) {
      const delay = Math.max(0, Number(raw) || 0);
      if (delay) {
        if (Date.now() + delay >= deadline) break;
        await new Promise((r) => setTimeout(r, delay));
      }
      if (Date.now() >= deadline) break;
      try {
        const found = await raceTimeout(Promise.resolve(get.call(port, room_id, message_id)), Math.max(1, deadline - Date.now()));
        if (found && found.length) return found;
      } catch { /* retry */ }
    }
    return [];
  }

  private async lookupAttachments(room_id: string, message_id: number): Promise<AttachmentMeta[]> {
    const get = this.o.port.getAttachments;
    if (!get) return [];
    try { return await get.call(this.o.port, room_id, message_id); } catch { return []; }
  }

  private publish(ev: BotEvent) {
    this.log.push(ev);
    for (const c of this.clients) if (hasScope(c.tok, "events:read") && this.o.allowlist.allows(ev.room_id, c.tok)) this.sendWs(c.ws, ev);
  }
  private broadcastRaw(x: unknown) { for (const c of this.clients) this.sendWs(c.ws, x); }
  private sendWs(ws: WebSocket, x: unknown) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(x)); }

  private upgrade(req: http.IncomingMessage, sock: any, head: Buffer) {
    const url = new URL(req.url || "/", "http://x");
    const tok = this.o.tokens.verify(req.headers.authorization);
    if (this.viaProxy(req)) { sock.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); sock.destroy(); return; }
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
        else for (const ev of back) {
          if (ev.type === "conversation_idle") {
            if (hasScope(tok, "context:read") && (!tok.rooms || tok.rooms.includes(ev.room_id))) this.sendWs(ws, ev);
          } else if (this.o.allowlist.allows(ev.room_id, tok)) this.sendWs(ws, ev);
        }
      }
    });
  }

  private json(s: http.ServerResponse, st: number, b: unknown, h: Record<string, string> = {}) { s.writeHead(st, { "content-type": "application/json", ...h }); s.end(JSON.stringify(b)); }
  private fail(s: http.ServerResponse, e: Err, h: Record<string, string> = {}) { this.json(s, e.status, { error: { code: e.code, message: e.message } }, h); }

  private isTrustedPeer(q: http.IncomingMessage) {
    const peer = (q.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    return (this.o.trustedProxies ?? ["127.0.0.1", "::1"]).includes(peer);
  }
  private viaProxy(q: http.IncomingMessage) { return this.isTrustedPeer(q) && q.headers["x-forwarded-for"] != null; }
  /** Real client IP: rightmost X-Forwarded-For entry (the one our proxy appended), only from a trusted peer. */
  clientIp(q: http.IncomingMessage) {
    const peer = (q.socket.remoteAddress ?? "?").replace(/^::ffff:/, "");
    const xff = q.headers["x-forwarded-for"];
    if (!this.isTrustedPeer(q) || xff == null) return peer;
    const parts = (Array.isArray(xff) ? xff.join(",") : xff).split(",").map((x) => x.trim()).filter(Boolean);
    return parts[parts.length - 1] || peer;
  }

  private async route(q: http.IncomingMessage, s: http.ServerResponse) {
    const url = new URL(q.url || "/", "http://x");
    const path = url.pathname;
    // Requests that came through the public reverse proxy (X-Forwarded-For from a trusted peer) may only
    // reach the human settings endpoints; everything else stays local-only.
    const proxied = this.viaProxy(q);
    const isSettings = /^\/bot\/rooms\/[^/]+\/settings$/.test(path);
    if (proxied && !isSettings) return this.fail(s, E(404, "not_found", "no such endpoint"));
    if (isSettings) {
      const origin = typeof q.headers.origin === "string" ? q.headers.origin : "";
      if (origin && (this.o.corsOrigins ?? []).includes(origin)) {
        s.setHeader("access-control-allow-origin", origin);
        s.setHeader("vary", "Origin");
        s.setHeader("access-control-allow-methods", "GET, PUT, OPTIONS");
        s.setHeader("access-control-allow-headers", "X-Daou-Session, Content-Type");
        s.setHeader("access-control-max-age", "600");
      }
      if (q.method === "OPTIONS") { s.writeHead(204, { allow: "GET, PUT, OPTIONS" }); s.end(); return; }
      if (q.method !== "GET" && q.method !== "PUT") return this.fail(s, E(405, "method_not_allowed", "GET, PUT, OPTIONS only"), { allow: "GET, PUT, OPTIONS" });
      // never let a proxied (public) request use a Bearer token
      if (proxied && q.headers.authorization) return this.fail(s, E(403, "bearer_not_allowed", "use X-Daou-Session"));
    }
    if (q.method === "GET" && path === "/bot/health") return this.json(s, 200, { ok: true, daou: this.o.port.healthy().state, ws_clients: this.clients.size, last_event_id: this.lastId() });
    const tok = this.o.tokens.verify(q.headers.authorization);
    const settingsMatch = (q.method === "GET" || q.method === "PUT") ? /^\/bot\/rooms\/([^/]+)\/settings$/.exec(path) : null;
    if (settingsMatch) return this.roomSettings(q, s, tok, settingsMatch[1]);
    if (!tok) return this.fail(s, E(401, "unauthorized", "missing or invalid bearer token"));
    const fileMatch = q.method === "GET" ? /^\/bot\/files\/(\d+)(\/text)?$/.exec(path) : null;
    if (fileMatch) return this.files(q, s, tok, Number(fileMatch[1]), !!fileMatch[2]);
    if (q.method === "GET" && path === "/bot/rooms") {
      const all = url.searchParams.get("all") === "1";
      if (all) {
        if (!hasScope(tok, "context:read")) return this.fail(s, E(403, "forbidden_scope", "context:read required"));
      } else if (!hasScope(tok, "rooms:read")) return this.fail(s, E(403, "forbidden_scope", "rooms:read required"));
      const rooms = (await this.o.port.listRooms())
        .filter((r) => { this.roomNames.set(r.room_id, r.room_name); return all ? (!tok.rooms || tok.rooms.includes(r.room_id)) : this.o.allowlist.allows(r.room_id, tok); })
        .map((r) => ({ room_id: r.room_id, room_name: r.room_name, kind: r.kind ?? "unknown", member_count: r.member_count ?? null, autonomy: this.isContextRoom(r.room_id) }));
      return this.json(s, 200, { rooms });
    }
    const messagesMatch = q.method === "GET" ? /^\/bot\/rooms\/([^/]+)\/messages$/.exec(path) : null;
    if (messagesMatch) {
      let room_id: string;
      try { room_id = decodeURIComponent(messagesMatch[1]); }
      catch { return this.fail(s, E(400, "bad_request", "invalid room_id")); }
      return this.roomMessages(url, s, tok, room_id);
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

  private publicSettings(settings: RoomSettings) {
    return {
      room_id: settings.room_id, autonomy: settings.autonomy,
      enabled_by: settings.enabled_by, enabled_at: settings.enabled_at,
      updated_by: settings.updated_by, updated_at: settings.updated_at, can_edit: true,
    };
  }

  private async roomSettings(q: http.IncomingMessage, s: http.ServerResponse, tok: TokenRecord | null, encodedRoom: string) {
    let room_id: string;
    try { room_id = decodeURIComponent(encodedRoom); }
    catch { return this.fail(s, E(400, "bad_request", "invalid room_id")); }
    const c = this.ctx;
    if (!c) return this.fail(s, E(404, "context_disabled", "context store is not configured"));
    const isGet = q.method === "GET";
    let actor: string;
    let token_id: string | undefined;
    if (tok) {
      if (isGet) {
        if (!hasScope(tok, "context:read") && !hasScope(tok, "settings:write"))
          return this.fail(s, E(403, "forbidden_scope", "context:read or settings:write required"));
      } else {
        // Turning autonomy on/off is a human decision: PUT only via a verified member session (X-Daou-Session).
        return this.fail(s, E(403, "human_session_required", "settings can only be changed by a room member session"));
      }
      if (tok.rooms && !tok.rooms.includes(room_id))
        return this.fail(s, E(403, "room_not_allowed", "token is not allowed for this room"));
      actor = tok.id;
      token_id = tok.id;
    } else {
      const raw = q.headers["x-daou-session"];
      const cookie = typeof raw === "string" ? raw : undefined;
      if (!cookie) return this.fail(s, E(401, "unauthorized", "missing authentication"));
      if (cookie.length > 4096 || /[\r\n]/.test(cookie))
        return this.fail(s, E(401, "invalid_session", "invalid session"));
      // throttle before the upstream coco call so random cookies cannot hammer it
      const ipKey = `ip:${this.clientIp(q)}`;
      const irl = this.humanRl.take(ipKey);
      if (!irl.ok) {
        const retry = Math.ceil(irl.retryAfterMs / 1000);
        return this.json(s, 429, { error: { code: "rate_limited", message: "slow down", retry_after_s: retry } }, { "retry-after": String(retry) });
      }
      const verify = this.o.port.verifyUserSession;
      if (!verify) return this.fail(s, E(401, "invalid_session", "invalid session"));
      let user: { user_id: string; name: string } | null = null;
      try { user = await verify.call(this.o.port, cookie); } catch { user = null; }
      if (!user) return this.fail(s, E(401, "invalid_session", "invalid session"));
      const rl = this.humanRl.take(user.user_id);
      if (!rl.ok) {
        const retry = Math.ceil(rl.retryAfterMs / 1000);
        return this.json(s, 429, { error: { code: "rate_limited", message: "slow down", retry_after_s: retry } }, { "retry-after": String(retry) });
      }
      let member = false;
      try { member = !!(this.o.port.isRoomMember && await this.o.port.isRoomMember(room_id, user.user_id)); } catch { member = false; }
      if (!member) return this.fail(s, E(403, "not_room_member", "user is not a member of this room"));
      actor = user.user_id;
    }
    if (isGet) return this.json(s, 200, this.publicSettings(c.store.getSettings(room_id)));
    let b: any;
    try { b = JSON.parse(await readBody(q, 16 * 1024)); }
    catch { return this.fail(s, E(400, "bad_request", "invalid JSON body")); }
    if (!b || typeof b.autonomy !== "boolean") return this.fail(s, E(400, "bad_request", "autonomy (boolean) required"));
    const prev = c.store.getSettings(room_id);
    const changed = prev.autonomy !== b.autonomy;
    const settings = c.store.setSettings(room_id, b.autonomy, actor);
    if (!b.autonomy) this.idle.delete(room_id);
    let notice_sent = false;
    if (changed) {
      this.audit.log({ action: "settings_update", ...(token_id ? { token_id } : {}), actor, room_id, autonomy: b.autonomy, status: "ok" });
      const notices = this.o.autonomyNotices ?? this.ctx?.autonomyNotices ?? true;
      const last = this.noticeAt.get(room_id) ?? 0;
      if (notices && this.now() - last >= 30_000) {
        this.noticeAt.set(room_id, this.now());
        try { await this.o.port.sendText(room_id, b.autonomy ? AUTONOMY_ON_NOTICE : AUTONOMY_OFF_NOTICE); notice_sent = true; }
        catch (e: any) { this.logf(`autonomy notice failed room=${room_id} err=${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 120)}`); }
      }
    }
    return this.json(s, 200, { settings: this.publicSettings(settings), notice_sent });
  }

  private roomMessages(url: URL, s: http.ServerResponse, tok: TokenRecord, room_id: string) {
    const c = this.ctx;
    if (!c) {
      this.audit.log({ action: "context_read", token_id: tok.id, room_id, status: "error", code: "context_disabled" });
      return this.fail(s, E(404, "context_disabled", "context store is not configured"));
    }
    if (!hasScope(tok, "context:read")) {
      this.audit.log({ action: "context_read", token_id: tok.id, room_id, status: "denied", code: "forbidden_scope" });
      return this.fail(s, E(403, "forbidden_scope", "context:read required"));
    }
    if (!this.isContextRoom(room_id) || (tok.rooms && !tok.rooms.includes(room_id))) {
      this.audit.log({ action: "context_read", token_id: tok.id, room_id, status: "denied", code: "room_not_allowed" });
      return this.fail(s, E(403, "room_not_allowed", "room is not available for context reads"));
    }
    const since = url.searchParams.get("since") ?? undefined;
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit != null && /^\d+$/.test(rawLimit) ? Number(rawLimit) : undefined;
    const messages = c.store.list(room_id, { since, limit });
    const numeric = since != null && /^\d+$/.test(since.trim());
    const last = messages[messages.length - 1];
    const next_since = last ? (numeric ? String(last.message_id) : last.ts) : (since ?? null);
    this.audit.log({ action: "context_read", token_id: tok.id, room_id, count: messages.length, status: "ok" });
    return this.json(s, 200, { room_id, messages, next_since });
  }

  private fileAudit(action: string, tok: TokenRecord, room_id: string | undefined, message_id: number, att: AttachmentMeta | undefined, status: string, code?: string) {
    this.audit.log({
      action, token_id: tok.id, ...(room_id ? { room_id } : {}), message_id,
      ...(att?.name ? { file_name: att.name } : {}),
      ...(att && typeof att.size === "number" ? { file_size: att.size } : {}),
      status, ...(code ? { code } : {}),
    });
  }

  private async files(q: http.IncomingMessage, s: http.ServerResponse, tok: TokenRecord, message_id: number, textMode: boolean) {
    const action = textMode ? "file_text" : "file_download";
    const url = new URL(q.url || "/", "http://x");
    const queryRoom = url.searchParams.get("room_id") || undefined;
    const rawIndex = url.searchParams.get("index");
    let index = 0;
    let badIndex = false;
    if (rawIndex != null) {
      if (!/^\d+$/.test(rawIndex)) badIndex = true;
      else {
        const n = Number(rawIndex);
        if (!Number.isSafeInteger(n)) badIndex = true; else index = n;
      }
    }
    const hasFiles = hasScope(tok, "files:read");
    const hasEvents = hasScope(tok, "events:read");
    if (!hasFiles && !hasEvents) {
      this.fileAudit(action, tok, queryRoom ?? this.messageRooms.get(message_id), message_id, undefined, "denied", "forbidden_scope");
      return this.fail(s, E(403, "forbidden_scope", "files:read or events:read required"));
    }
    const frl = this.fileRl.take(tok.id);
    if (!frl.ok) {
      const retry = Math.ceil(frl.retryAfterMs / 1000);
      this.fileAudit(action, tok, queryRoom ?? this.messageRooms.get(message_id), message_id, undefined, "limited", "rate_limited");
      return this.json(s, 429, { error: { code: "rate_limited", message: "slow down", retry_after_s: retry } }, { "retry-after": String(retry) });
    }
    if (badIndex) {
      this.fileAudit(action, tok, queryRoom ?? this.messageRooms.get(message_id), message_id, undefined, "error", "not_found");
      return this.fail(s, E(404, "not_found", "attachment not found"));
    }

    // Access rule: only messages actually delivered to the adapter (message.created), or messages
    // stored from a room whose autonomy is on. No guessing across rooms by id.
    let room_id: string | undefined;
    let atts: AttachmentMeta[] = [];
    let delivered = this.messageRooms.get(message_id);
    if (!delivered) { try { delivered = this.ctx?.store.deliveredRoom(message_id) ?? undefined; } catch { delivered = undefined; } }
    if (delivered && (!queryRoom || queryRoom === delivered)) {
      room_id = delivered;
      if (!this.o.allowlist.allows(room_id, tok)) {
        this.fileAudit(action, tok, room_id, message_id, undefined, "denied", "room_not_allowed");
        return this.fail(s, E(403, "room_not_allowed", "room is not allowlisted"));
      }
    } else if (queryRoom && hasScope(tok, "context:read") && this.ctx && this.isContextRoom(queryRoom) && this.ctx.store.hasMessage(queryRoom, message_id)) {
      room_id = queryRoom;
      if (tok.rooms && !tok.rooms.includes(room_id)) {
        this.fileAudit(action, tok, room_id, message_id, undefined, "denied", "room_not_allowed");
        return this.fail(s, E(403, "room_not_allowed", "room is not allowed for this token"));
      }
    }
    if (room_id) atts = await this.lookupAttachments(room_id, message_id);
    if (!room_id || !atts.length) {
      this.fileAudit(action, tok, room_id, message_id, undefined, "error", "not_found");
      return this.fail(s, E(404, "not_found", "attachment not found"));
    }
    const att = atts[index];
    if (!att) {
      this.fileAudit(action, tok, room_id, message_id, undefined, "error", "not_found");
      return this.fail(s, E(404, "not_found", "attachment not found"));
    }
    const max = this.o.maxFileBytes ?? 20 * 1024 * 1024;
    if (typeof att.size === "number" && att.size > max) {
      this.fileAudit(action, tok, room_id, message_id, att, "error", "too_large");
      return this.fail(s, E(413, "too_large", "file exceeds maxFileBytes"));
    }
    const download = this.o.port.downloadAttachment;
    if (!download) {
      this.fileAudit(action, tok, room_id, message_id, att, "error", "not_found");
      return this.fail(s, E(404, "not_found", "attachment not found"));
    }
    let file: { data: Buffer; contentType: string; name: string };
    try { file = await download.call(this.o.port, room_id, message_id, index, att.file_id, max); }
    catch (e) {
      if ((e as any)?.status === 413) {
        this.fileAudit(action, tok, room_id, message_id, att, "error", "too_large");
        return this.fail(s, E(413, "too_large", "file exceeds maxFileBytes"));
      }
      this.fileAudit(action, tok, room_id, message_id, att, "error", "not_found");
      return this.fail(s, E(404, "not_found", "attachment not found"));
    }
    if (file.data.length > max) {
      this.fileAudit(action, tok, room_id, message_id, { ...att, size: file.data.length }, "error", "too_large");
      return this.fail(s, E(413, "too_large", "file exceeds maxFileBytes"));
    }
    const name = file.name || att.name || "file";
    const mime = mimeFor(name);
    if (!textMode) {
      this.fileAudit(action, tok, room_id, message_id, { ...att, name }, "ok");
      s.writeHead(200, {
        "content-type": mime,
        "content-length": String(file.data.length),
        "content-disposition": contentDisposition(name),
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      s.end(file.data);
      return;
    }
    let extracted: { text: string; mime: string };
    try { extracted = await extractText(name, file.data); }
    catch (e) {
      if (e instanceof ExtractError) {
        this.fileAudit(action, tok, room_id, message_id, { ...att, name }, "error", e.code);
        return this.fail(s, E(e.status, e.code, e.message));
      }
      this.fileAudit(action, tok, room_id, message_id, { ...att, name }, "error", "extract_failed");
      return this.fail(s, E(500, "internal", "internal error"));
    }
    const chars = extracted.text.length;
    const truncated = chars > 200_000;
    const text = truncated ? extracted.text.slice(0, 200_000) : extracted.text;
    this.fileAudit(action, tok, room_id, message_id, { ...att, name }, "ok");
    return this.json(s, 200, { message_id, index, name, mime: extracted.mime, chars, truncated, text });
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
      if ((this.o.statusMode ?? "chatstate") === "chatstate") {
        const now = (this.o.now ?? Date.now)(), gap = this.o.statusThrottleMs ?? 3000, last = this.lastStatus.get(b.room_id);
        // A failed send must not consume the throttle window (the retry would be silently "throttled").
        const unthrottle = () => { if (b.state === "done") return; if (last == null) this.lastStatus.delete(b.room_id); else this.lastStatus.set(b.room_id, last); };
        if (b.state !== "done") {
          if (last != null && now - last < gap) { this.audit.log({ action: "status", token_id: tok.id, room_id: b.room_id, status: "throttled", code: b.state }); return { status: 200, body: { ok: true, throttled: true, state: b.state } }; }
          this.lastStatus.set(b.room_id, now);
        }
        let text = "";
        if (b.state === "thinking") text = "생각 중";
        else if (b.state === "working") {
          const t = String(b.text ?? "").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
          text = t ? [...t].slice(0, 60).join("") : "작업 중";
        }
        if (!this.o.port.sendChatState) {
          this.logf(`chatstate unsupported room=${b.room_id}`); unthrottle();
          this.audit.log({ action: "status", token_id: tok.id, room_id: b.room_id, status: "error", code: "upstream_error" });
          return err(E(502, "upstream_error", "DaouOffice chat state unsupported"));
        }
        try {
          const r = await this.o.port.sendChatState(b.room_id, b.state, text);
          this.audit.log({ action: "status", token_id: tok.id, room_id: b.room_id, status: "ok", code: b.state });
          return { status: 200, body: { ok: true, state: b.state, mode: "chatstate", recipients: r.recipients } };
        } catch (e: any) {
          unthrottle();
          this.logf(`chatstate send failed room=${b.room_id} err=${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 120)}`);
          this.audit.log({ action: "status", token_id: tok.id, room_id: b.room_id, status: "error", code: "upstream_error" });
          return err(E(502, "upstream_error", "DaouOffice chat state failed"));
        }
      }
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

function looksLikeFile(m: InboundMessage): boolean {
  if (/FILE|IMAGE/i.test(m.messageType ?? "")) return true;
  return /^[^\n\/\\]{1,255}\.[A-Za-z0-9]{1,8}$/.test(m.text ?? "");
}

function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
