import { createHash } from "crypto";
import { MessengerCore } from "../../desktop/electron/core/messenger";
import { HttpError } from "../../desktop/electron/core/daou-client";
import type { AttachModel, RoomKind } from "../../desktop/electron/core/types";
import type { BotRoom, DaouPort, InboundMessage } from "./types";
import { mimeFor } from "./mime";
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
  private sessionCache = new Map<string, { at: number; user: { user_id: string; name: string } | null }>();
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
  async listRooms(): Promise<BotRoom[]> { return (await this.core.client.listRooms()).map((r) => ({ room_id: r.key, room_name: r.name, kind: r.kind, member_count: r.memberCount ?? null })); }
  async sendText(room_id: string, text: string) { const r: any = await this.core.sendText(room_id, text); return { message_id: r?.messageId }; }
  async sendChatState(room_id: string, state: "thinking" | "working" | "done", text: string) { return { recipients: await this.core.sendBotStatus(room_id, state, text) }; }
  async sendFile(room_id: string, file: { name: string; data: Buffer; mime?: string }) { const r: any = await this.core.sendFile(room_id, file); return { message_id: r?.messageId }; }
  async deleteMessages(_room_id: string, ids: number[]) { await this.core.client.deleteChatMessages(ids); }
  async markRead(room_id: string, message_id: number) { try { await this.core.markRead(room_id, message_id); } catch (e) { this.log(`markRead failed ${room_id}: ${describeError(e)}`); } }
  private roomSeq(room_id: string): { kind: RoomKind; seq: number } {
    const i = room_id.indexOf(":");
    return { kind: (i < 0 ? "unknown" : room_id.slice(0, i)) as RoomKind, seq: i < 0 ? 0 : Number(room_id.slice(i + 1)) };
  }
  async getAttachments(room_id: string, message_id: number): Promise<Array<{ name: string; size?: number; mime?: string; file_id: string; image?: boolean }>> {
    const { kind, seq } = this.roomSeq(room_id);
    const pick = (msgs: Array<{ messageId?: number }>) => msgs.find((m) => m.messageId === message_id);
    let msg: { messageId?: number; attach?: AttachModel } | undefined = pick(await this.core.client.fetchMessages(kind, seq, 40)) as any;
    if (!msg) msg = pick(await this.core.client.fetchMessages(kind, seq, 20, message_id + 1)) as any;
    const a = msg?.attach;
    if (!a) return [];
    const name = a.name || "file";
    const ext = a.extention ? `.${String(a.extention).replace(/^\./, "")}` : "";
    return [{ name, size: a.size, mime: mimeFor(/\.[a-z0-9]{1,8}$/i.test(name) ? name : `${name}${ext}`), file_id: a.cryptId, image: !!a.imageFile }];
  }
  async downloadAttachment(room_id: string, message_id: number, index: number, file_id?: string, maxBytes = 20 * 1024 * 1024): Promise<{ data: Buffer; contentType: string; name: string }> {
    let id = file_id;
    let name = "";
    if (!id) {
      const atts = await this.getAttachments(room_id, message_id);
      const att = atts[index];
      if (!att) throw new Error("attachment not found");
      id = att.file_id;
      name = att.name;
    }
    const res = await this.core.client.fetchCapped(this.core.client.fileUrlPath(id, message_id), maxBytes);
    return { data: res.data, contentType: mimeFor(name), name };
  }
  async verifyUserSession(cookie: string): Promise<{ user_id: string; name: string } | null> {
    const key = createHash("sha256").update(cookie, "utf8").digest("hex");
    const now = Date.now();
    const hit = this.sessionCache.get(key);
    if (hit && now - hit.at < 60_000) return hit.user;
    let user: { user_id: string; name: string } | null = null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${this.cfg.serverUrl.replace(/\/$/, "")}/api/user/session`, {
        method: "GET",
        headers: { Cookie: cookie, "X-Requested-With": "XMLHttpRequest", Accept: "application/json, text/javascript, */*; q=0.01" },
        redirect: "manual",
        signal: ctrl.signal,
      });
      if (res.status === 200) {
        const body: any = await res.json().catch(() => null);
        const id = body?.data?.id;
        if (id != null && id !== "") user = { user_id: String(id), name: String(body?.data?.name ?? "") };
      }
    } catch {
      user = null;
    } finally {
      clearTimeout(timer);
    }
    this.sessionCache.set(key, { at: now, user });
    while (this.sessionCache.size > 500) {
      const first = this.sessionCache.keys().next();
      if (first.done) break;
      this.sessionCache.delete(first.value);
    }
    return user;
  }
  async isRoomMember(room_id: string, user_id: string): Promise<boolean> {
    const i = room_id.indexOf(":");
    const kind = i < 0 ? "" : room_id.slice(0, i);
    const seq = i < 0 ? Number.NaN : Number(room_id.slice(i + 1));
    if (!Number.isFinite(seq)) return false;
    if (kind === "buddy") return String(seq) === String(user_id);
    if (kind === "room") {
      const members = await this.core.client.listMembers(seq);
      return members.some((m) => String(m.userId) === String(user_id));
    }
    return false;
  }
  onMessage(cb: (m: InboundMessage) => void) {
    return this.core.on("message", (m) => (m as any).attachUpdate ? undefined : cb({
      room_id: m.roomKey, message_id: m.messageId ?? 0, sender: { id: String(m.sendUserSeq ?? ""), name: m.sendUserName }, text: m.message ?? "",
      mentions: [...(m.message ?? "").matchAll(/@\[?([^\s\]]+)/g)].map((x) => x[1]),
      attachments: m.attach ? [{ name: m.attach.name ?? "file", size: m.attach.size, type: mimeFor(m.attach.name ?? "file"), file_id: m.attach.cryptId, image: !!m.attach.imageFile }] : [],
      reply_to: null, ts: m.createdAt ?? new Date().toISOString(), is_mine: m.isMine, messageType: m.messageType,
    }));
  }
  onRoomJoined(cb: (r: BotRoom) => void) {
    return this.core.on("rooms", (rooms) => { for (const r of rooms) if (!this.known.has(r.key)) { this.known.add(r.key); cb({ room_id: r.key, room_name: r.name }); } });
  }
}
