import { EventEmitter } from "node:events";
import { DaouClient, sortRooms } from "./daou-client";
import { XmppClient } from "./xmpp";
import { xmppKeyFromLoginId } from "./xmpp-key";
import { canonMessageId } from "./messages";
import type {
  ChatMessage,
  ConnState,
  Department,
  LoginOptions,
  MessengerEventMap,
  Person,
  Presence,
  Room,
  RoomKind,
  SessionUser,
} from "./types";

export function parsePresence(type?: string, status?: string, show?: string): Presence {
  if (type === "unavailable") return "offline";
  const s = (status || "").toLowerCase();
  if (s.startsWith("away") || show === "away" || show === "xa") return "away";
  if (s.startsWith("busy") || s.startsWith("dnd") || show === "dnd") return "busy";
  return "online";
}

/** Map an XMPP JSON body (official desktop format) to a room-scoped message. Pure; unit-tested. */
export function routeXmppBody(obj: Record<string, any>, me: number) {
  const fr = (obj.from && typeof obj.from === "object" ? obj.from : {}) as Record<string, any>;
  const subtype = String(obj.subtype || "");
  const type = String(obj.type || "message");
  const fromSeq = fr.userSeq != null ? Number(fr.userSeq) : undefined;
  const toSeq = obj.toSeq != null ? Number(obj.toSeq) : undefined;
  let kind: RoomKind = "unknown";
  let seq: number | undefined;
  if (subtype === "single") {
    kind = "buddy";
    seq = fromSeq === me ? toSeq : fromSeq;
  } else if (subtype === "pubsub") {
    kind = "pubsub";
    seq = toSeq ?? fromSeq;
  } else if (["group", "room", "roomjoin", "roomleave", "roomkickout"].includes(subtype) || toSeq != null) {
    kind = "room";
    seq = toSeq;
  }
  const a = obj.chatMessageAttachFileModel || obj.attach;
  const msg: ChatMessage = {
    messageId: canonMessageId(obj.messageId),
    sendUserSeq: fromSeq,
    sendUserName: String(fr.userName || ""),
    message: String(obj.message ?? ""),
    createdAt: obj.createdAt || obj.sendDate || obj.sendAt || new Date().toISOString(),
    userImage: String(fr.userImg || ""),
    messageType: obj.messageType ? String(obj.messageType) : a?.cryptId ? "SENDFILE" : "TEXT",
    attach: a?.cryptId
      ? {
          cryptId: String(a.cryptId),
          name: String(a.name || obj.message || "file"),
          extention: a.extention,
          size: a.size != null ? Number(a.size) : undefined,
          imageFile: !!a.imageFile,
          thumbSmall: a.thumbSmall,
          thumbMid: a.thumbMid,
          thumbLarge: a.thumbLarge,
          thumbOriginal: a.thumbOriginal,
        }
      : undefined,
  };
  return { type, subtype, kind, seq, msg, usePush: obj.usePush !== false, isMine: fromSeq === me };
}

type Listener<K extends keyof MessengerEventMap> = (p: MessengerEventMap[K]) => void;

/**
 * messenger-core: the one stateful object that owns REST + XMPP.
 * UI (IPC) and the phase-2 bot adapter both consume only this surface:
 *   events: ready | rooms | message | confirm | presence | connection | loggedOut
 *   commands: login, logout, listRooms, history, sendText, sendFile, markRead, users, openDirect…
 */
export class MessengerCore {
  readonly client: DaouClient;
  private xmpp: XmppClient | null = null;
  private em = new EventEmitter();
  private rooms = new Map<string, Room>();
  private presence = new Map<number, Map<string, Presence>>();
  private usersCache: Person[] | null = null;
  private deptCache: Department[] | null = null;
  conn: ConnState = "offline";
  activeRoomKey: string | null = null;
  focused = true;

  constructor(serverUrl?: string) {
    this.client = new DaouClient(serverUrl);
    this.em.setMaxListeners(50);
  }

  on<K extends keyof MessengerEventMap>(e: K, l: Listener<K>) {
    this.em.on(e, l as any);
    return () => this.em.off(e, l as any);
  }
  private emit<K extends keyof MessengerEventMap>(e: K, p: MessengerEventMap[K]) {
    this.em.emit(e, p);
  }

  get user(): SessionUser | null {
    return this.client.user;
  }

  async login(opts: LoginOptions): Promise<SessionUser> {
    this.setConn("connecting");
    try {
      const u = await this.client.login(opts);
      this.startXmpp(new URL(opts.serverUrl).hostname);
      this.emit("ready", u);
      void this.refreshRooms().catch(() => undefined);
      return u;
    } catch (e) {
      this.setConn("offline");
      throw e;
    }
  }

  /** Stop realtime without invalidating the server session (app quit). */
  shutdown() {
    this.xmpp?.stop();
    this.xmpp = null;
  }

  async logout(reason?: string) {
    this.xmpp?.stop();
    this.xmpp = null;
    await this.client.logout();
    this.rooms.clear();
    this.presence.clear();
    this.usersCache = this.deptCache = null;
    this.setConn("offline");
    this.emit("loggedOut", { reason });
  }

  private setConn(state: ConnState, error?: string) {
    this.conn = state;
    this.emit("connection", { state, error });
  }

  private startXmpp(host: string) {
    this.xmpp?.stop();
    const u = this.client.user!;
    const x = new XmppClient({
      host,
      port: 5222,
      domain: this.client.xmppDomain,
      username: String(u.repId),
      password: xmppKeyFromLoginId(this.client.loginIdForXmpp()),
      resource: this.client.resource,
    });
    let wasOnline = false;
    x.on("state", (s: string, err?: string) => {
      if (s === "online") {
        this.setConn("online");
        // catch up on anything missed while disconnected
        if (wasOnline) void this.refreshRooms().catch(() => undefined);
        wasOnline = true;
      } else if (s === "connecting") this.setConn(wasOnline ? "reconnecting" : "connecting");
      else this.setConn(this.xmpp ? "reconnecting" : "offline", err);
    });
    x.on("presence", (p: { local: string; resource: string; type?: string; status?: string; show?: string }) => {
      const id = Number(p.local);
      if (!Number.isFinite(id)) return;
      const per = this.presence.get(id) || new Map<string, Presence>();
      const v = parsePresence(p.type, p.status, p.show);
      if (v === "offline") per.delete(p.resource);
      else per.set(p.resource, v);
      this.presence.set(id, per);
      this.emit("presence", { userId: id, presence: this.presenceOf(id) });
    });
    x.on("body", (obj: Record<string, any>) => this.onBody(obj));
    this.xmpp = x;
    x.start();
  }

  /** Re-establish realtime after sleep / network change. */
  reconnect() {
    this.xmpp?.kick();
  }

  setAway(away: boolean) {
    this.xmpp?.setStatus(away ? "away:on" : "online:on");
  }

  presenceOf(userId: number): Presence {
    const per = this.presence.get(userId);
    if (!per || per.size === 0) return "offline";
    const vals = [...per.values()];
    if (vals.includes("online")) return "online";
    if (vals.includes("busy")) return "busy";
    return "away";
  }

  allPresence(): Record<number, Presence> {
    const out: Record<number, Presence> = {};
    for (const id of this.presence.keys()) out[id] = this.presenceOf(id);
    return out;
  }

  private onBody(obj: Record<string, any>) {
    const me = this.client.user?.id;
    if (me == null) return;
    const r = routeXmppBody(obj, me);
    if (r.type === "confirm") {
      this.emit("confirm", { roomKey: r.seq != null ? `${r.kind}:${r.seq}` : undefined, messageId: r.msg.messageId });
      return;
    }
    if (r.type !== "message" || r.seq == null || r.kind === "unknown") return;
    const key = `${r.kind}:${r.seq}`;
    const msg = { ...r.msg, roomKey: key };
    const room = this.rooms.get(key);
    const viewing = this.activeRoomKey === key && this.focused;
    if (room) {
      room.preview = msg.attach ? `📎 ${msg.attach.name}` : msg.message.slice(0, 200);
      room.messageId = msg.messageId ?? room.messageId;
      room.createdAt = msg.createdAt;
      if (!r.isMine && !viewing) room.unread += 1;
      this.emitRooms();
    } else {
      void this.refreshRooms().catch(() => undefined);
    }
    this.emit("message", {
      ...msg,
      roomKey: key,
      roomKind: r.kind,
      roomSeq: r.seq,
      isMine: r.isMine,
      usePush: r.usePush && (room ? room.usePush : true),
    });
  }

  private emitRooms() {
    this.emit("rooms", this.getRooms());
  }

  getRooms(): Room[] {
    return sortRooms([...this.rooms.values()]);
  }

  unreadTotal(): number {
    let n = 0;
    for (const r of this.rooms.values()) if (r.usePush) n += r.unread;
    return n;
  }

  async refreshRooms(): Promise<Room[]> {
    const list = await this.client.listRooms();
    this.rooms = new Map(list.map((r) => [r.key, r]));
    if (this.activeRoomKey && this.focused) {
      const a = this.rooms.get(this.activeRoomKey);
      if (a) a.unread = 0;
    }
    this.emitRooms();
    return this.getRooms();
  }

  private parseKey(key: string): { kind: RoomKind; seq: number } {
    const [kind, seq] = key.split(":");
    return { kind: kind as RoomKind, seq: Number(seq) };
  }

  history(key: string, before?: number, size = 40) {
    const { kind, seq } = this.parseKey(key);
    return this.client.fetchMessages(kind, seq, size, before);
  }

  searchInRoom(key: string, keyword: string) {
    const { kind, seq } = this.parseKey(key);
    return this.client.searchMessages(kind, seq, keyword);
  }

  async sendText(key: string, text: string) {
    const { kind, seq } = this.parseKey(key);
    const res = await this.client.sendMessage(kind, seq, text);
    const room = this.rooms.get(key);
    if (room) {
      room.preview = text.slice(0, 200);
      room.createdAt = new Date().toISOString();
      room.messageId = res.messageId ?? room.messageId;
      this.emitRooms();
    }
    return res;
  }

  async sendFile(key: string, file: { name: string; data: Buffer; mime?: string }) {
    const { kind, seq } = this.parseKey(key);
    return this.client.sendFile(kind, seq, file);
  }

  /** Mark read up to the latest message, only meaningful when room is open + window focused. */
  async markRead(key: string, messageId?: number) {
    const room = this.rooms.get(key);
    const mid = messageId ?? room?.messageId;
    if (room && room.unread) {
      room.unread = 0;
      this.emitRooms();
    }
    if (!mid) return;
    const { kind, seq } = this.parseKey(key);
    await this.client.markRead(kind, seq, mid);
  }

  setActiveRoom(key: string | null) {
    this.activeRoomKey = key;
  }

  async users(force = false): Promise<Person[]> {
    if (!this.usersCache || force) {
      const [users, depts] = await Promise.all([this.client.listUsers(), this.departments()]);
      const byUser = new Map<number, number[]>();
      for (const d of depts) for (const uid of d.memberIds || []) byUser.set(uid, [...(byUser.get(uid) || []), d.id]);
      this.usersCache = users.map((u) => (u.departmentIds.length ? u : { ...u, departmentIds: byUser.get(u.userId) || [] }));
    }
    return this.usersCache;
  }

  async departments(): Promise<Department[]> {
    if (!this.deptCache) this.deptCache = await this.client.listDepartments();
    return this.deptCache;
  }

  /** Open (or create locally) a 1:1 room: DM rooms are addressed by the peer user id. */
  async openDirect(userId: number): Promise<Room> {
    const key = `buddy:${userId}`;
    let room = this.rooms.get(key);
    if (!room) {
      const p = (await this.users()).find((u) => u.userId === userId);
      room = {
        key,
        kind: "buddy",
        seq: userId,
        name: p?.name || String(userId),
        preview: "",
        unread: 0,
        usePin: false,
        usePush: true,
        avatar: p?.thumbnail || "",
        isSelf: userId === this.user?.id,
        peerUserId: userId,
        position: p?.position,
      };
      this.rooms.set(key, room);
      this.emitRooms();
    }
    return room;
  }

  async createGroup(memberIds: number[]): Promise<Room> {
    const seq = await this.client.createGroupRoom(memberIds);
    await this.refreshRooms();
    return this.rooms.get(`room:${seq}`) || {
      key: `room:${seq}`, kind: "room", seq, name: "새 대화방", preview: "", unread: 0, usePin: false, usePush: true, avatar: "", isSelf: false,
    };
  }

  async setPin(key: string, pin: boolean) {
    const room = this.rooms.get(key);
    if (!room) return;
    await this.client.setPin(room, pin);
    room.usePin = pin;
    this.emitRooms();
  }
}
