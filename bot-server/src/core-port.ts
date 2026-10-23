import { MessengerCore } from "../../desktop/electron/core/messenger";
import { HttpError } from "../../desktop/electron/core/daou-client";
import type { BotRoom, DaouPort, InboundMessage } from "./types";
import { mask, ReloginPolicy } from "./session";

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
    try {
      this.log(`login as ${mask(this.cfg.username)}`);
      await this.core.login({ serverUrl: this.cfg.serverUrl, username: this.cfg.username, password: this.cfg.password });
      this.policy.onSuccess(); (await this.listRooms()).forEach((r) => this.known.add(r.room_id));
    } catch (e) {
      const auth = e instanceof HttpError && (e.webLogin || e.status === 401 || e.status === 403);
      this.log(`login failed (${auth ? "auth" : "net"})`); this.schedule(auth ? "auth" : "net");
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
