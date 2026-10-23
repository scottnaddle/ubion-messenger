import { MessengerCore } from "../../desktop/electron/core/messenger";
import { HttpError } from "../../desktop/electron/core/daou-client";
import type { BotRoom, DaouPort, InboundMessage } from "./types";
import { mask, ReloginPolicy } from "./session";

const SECRETISH = /(pass(word)?|pwd|token|cookie|session|sso|auth|key|secret|otp|ticket)=([^&\s"';]+)/gi;
/** Remove query strings from URLs and mask key=value secrets; collapse whitespace; cap length. */
export function sanitize(s: unknown, max = 300): string {
  return String(s ?? "")
    .replace(/(https?:\/\/[^\s"'?#]+)[?#][^\s"']*/gi, "$1?…")
    .replace(/([?&;]|\b)(\/[^\s?"']*)\?[^\s"']+/g, "$1$2?…")
    .replace(SECRETISH, "$1=***")
    .replace(/GOSSOcookie[^;\s]*/gi, "GOSSOcookie=***")
    .replace(/\s+/g, " ").trim().slice(0, max);
}
/** One-line, secret-free description of a login failure: kind, name, code/cause chain, HTTP status, server diag. */
export function describeError(e: unknown): string {
  const parts: string[] = [];
  const err = e as any;
  parts.push(`type=${e instanceof HttpError ? "HttpError" : err?.name || typeof e}`);
  if (e instanceof HttpError) { parts.push(`status=${e.status}`); if (e.webLogin) parts.push("webLogin=true"); if (e.diag) parts.push(`diag=[${sanitize(e.diag)}]`); }
  if (err?.code) parts.push(`code=${err.code}`);
  if (err?.name === "AbortError") parts.push("timeout=30s");
  let c = err?.cause, depth = 0;
  while (c && depth++ < 3) { parts.push(`cause=${c.name || "Error"}${c.code ? `/${c.code}` : ""}:${sanitize(c.message, 120)}`); c = c.cause; }
  parts.push(`msg=${sanitize(err?.message ?? e, 200)}`);
  if (!(e instanceof HttpError) && err?.stack) parts.push(`at=${sanitize(String(err.stack).split("\n").slice(1, 3).join(" | "), 200)}`);
  return parts.join(" ");
}

/** Real DaouPort over the desktop MessengerCore (REST + BOSH). Logs in as the dedicated bot account only. */
export class CorePort implements DaouPort {
  core: MessengerCore; private policy = new ReloginPolicy(); private known = new Set<string>(); state = "offline";
  constructor(private cfg: { serverUrl: string; username: string; password: string }, private log: (m: string) => void) {
    this.core = new MessengerCore(cfg.serverUrl);
    this.core.log = (m) => log(`[core] ${m}`);
    this.core.on("connection", ({ state }) => (this.state = state));
    this.core.on("loggedOut", () => this.schedule("net"));
  }
  async start() {
    let phase = "login";
    try {
      this.log(`login as ${mask(this.cfg.username)}`);
      await this.core.login({ serverUrl: this.cfg.serverUrl, username: this.cfg.username, password: this.cfg.password });
      phase = "post-login(listRooms)"; this.log("login ok");
      this.policy.onSuccess(); const rooms = await this.listRooms(); rooms.forEach((r) => this.known.add(r.room_id)); this.log(`rooms(${rooms.length}): ${rooms.map((r) => `${r.room_id}=${sanitize(r.room_name, 40)}`).join(", ")}`);
    } catch (e) {
      const auth = e instanceof HttpError && (e.webLogin || e.status === 401 || e.status === 403 || e.status === 423);
      this.log(`login failed (${auth ? "auth" : "net"}) phase=${phase} ${describeError(e)}`); this.schedule(auth ? "auth" : "net");
    }
  }
  private schedule(kind: "auth" | "net") {
    const d = this.policy.onFailure(kind);
    if (d == null) { this.state = "halted"; this.log("HALTED: credentials rejected twice; fix secret and restart (lockout safety)"); return; }
    setTimeout(() => void this.start(), d).unref();
  }
  botUserId() { return this.core.user ? String(this.core.user.id) : null; }
  botName() { return (this.core.user as any)?.name ?? ""; }
  healthy() { return { state: this.state }; }
  async listRooms(): Promise<BotRoom[]> { return (await this.core.client.listRooms()).map((r) => ({ room_id: r.key, room_name: r.name })); }
  async sendText(room_id: string, text: string) { const r: any = await this.core.sendText(room_id, text); return { message_id: r?.messageId }; }
  async markRead(room_id: string, message_id: number) { try { await this.core.markRead(room_id, message_id); } catch (e) { this.log(`markRead failed ${room_id}: ${describeError(e)}`); } }
  onMessage(cb: (m: InboundMessage) => void) {
    return this.core.on("message", (m) => cb({
      room_id: m.roomKey, message_id: m.messageId ?? 0, sender: { id: String(m.sendUserSeq ?? ""), name: m.sendUserName }, text: m.message ?? "",
      mentions: [...(m.message ?? "").matchAll(/@\[?([^\s\]]+)/g)].map((x) => x[1]),
      attachments: m.attach ? [{ name: (m.attach as any).name ?? "file", size: (m.attach as any).size }] : [], reply_to: null,
      ts: m.createdAt ?? new Date().toISOString(), is_mine: m.isMine,
    }));
  }
  onRoomJoined(cb: (r: BotRoom) => void) {
    return this.core.on("rooms", (rooms) => { for (const r of rooms) if (!this.known.has(r.key)) { this.known.add(r.key); cb({ room_id: r.key, room_name: r.name }); } });
  }
}
