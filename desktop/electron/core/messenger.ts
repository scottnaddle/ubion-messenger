import { normalizeAttach } from "./attach";
import { EventEmitter } from "node:events";
import { DaouClient, sortRooms } from "./daou-client";
import { PortalService } from "./portal";
import { XmppClient } from "./xmpp";
import { BoshClient } from "./bosh";
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
  RoomMember,
  SessionUser,
} from "./types";

export function parsePresence(type?: string, status?: string, show?: string): Presence {
  if (type === "unavailable") return "offline";
  const s = (status || "").toLowerCase();
  if (s.startsWith("away") || show === "away" || show === "xa") return "away";
  if (s.startsWith("busy") || s.startsWith("dnd") || show === "dnd") return "busy";
  return "online";
}

/** Non-chat JSON body types pushed over XMPP. Anything else carrying a room is a chat message
 *  (server sends type "chat" for 1:1 — the official client never filters on type). */
const NON_CHAT = new Set(["confirm", "presence", "noti", "headline", "timeline", "terminate"]);
export function isChatType(type: string) {
  return !NON_CHAT.has(type);
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
  const senderSeq = obj.senderSeq != null ? Number(obj.senderSeq) : undefined;
  if (subtype === "single") {
    kind = "buddy";
    // official client: a confirm sent by me (read on another device) belongs to the room of senderSeq
    seq = type === "confirm" && fromSeq === me ? senderSeq ?? toSeq : fromSeq === me ? toSeq : fromSeq;
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
    messageType: obj.messageType ? String(obj.messageType) : normalizeAttach(a) ? "SENDFILE" : "TEXT",
    attach: normalizeAttach(a, obj.message ? String(obj.message) : undefined, obj.createdAt || obj.sendDate || obj.sendAt || new Date().toISOString()),
  };
  const receipt =
    type === "confirm" && fromSeq != null && seq != null
      ? {
          roomKey: `${kind}:${seq}`,
          readerSeq: fromSeq,
          beginId: canonMessageId(obj.confirmedBeginMessageId),
          endId: canonMessageId(obj.confirmedEndMessageId) ?? canonMessageId(obj.messageId),
        }
      : undefined;
  if (obj.needConfirmCount != null) msg.needConfirmCount = Number(obj.needConfirmCount);
  return { type, subtype, kind, seq, msg, usePush: obj.usePush !== false, isMine: fromSeq === me, isChat: isChatType(type), receipt };
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
  /** Read-only portal home (GET whitelist), shares the client's GOSSOcookie session. */
  readonly portal: PortalService;
  private xmpp: XmppClient | BoshClient | null = null;
  /** Realtime transport in use ("bosh" = XMPP over HTTPS, default; "tcp" = plaintext 5222 fallback). */
  transport: "bosh" | "tcp" | null = null;
  /** Hidden setting: allow plaintext TCP 5222 if BOSH cannot connect (off by default). */
  allowTcpFallback = false;
  /** BOSH failures (before ever online) that trigger the TCP fallback when allowed. */
  tcpFallbackAfter = 3;
  log: (msg: string) => void = (m) => console.log(`[core] ${m}`);
  private em = new EventEmitter();
  private rooms = new Map<string, Room>();
  private presence = new Map<number, Map<string, Presence>>();
  private usersCache: Person[] | null = null;
  private deptCache: Department[] | null = null;
  conn: ConnState = "offline";
  /** highest messageId already delivered to listeners, per room */
  private lastIds = new Map<string, number>();
  private emitted = new Set<number>();
  private pollTimer: NodeJS.Timeout | null = null;
  private syncing: Promise<void> | null = null;
  private roomSyncTimers = new Map<string, NodeJS.Timeout>();
  pollMs = 20_000;
  activeRoomKey: string | null = null;
  focused = true;

  constructor(serverUrl?: string) {
    this.client = new DaouClient(serverUrl);
    this.portal = new PortalService((path, init) => this.client.request(path, init?.method === "POST" ? { method: "POST", json: init.json } : { method: "GET" }), (e, p) => this.emit(e, p as any));
    this.em.setMaxListeners(50);
    this.portal.getUserId = () => this.client.user?.id ?? null;
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
      return this.afterLogin(u, opts.serverUrl);
    } catch (e) {
      this.setConn("offline");
      throw e;
    }
  }

  /** Continue normal bootstrap with a cookie session completed in the web-login window. */
  async loginWithWebSession(serverUrl: string, cookies: import("./web-login").ElectronCookieIn[]): Promise<SessionUser> {
    this.setConn("connecting");
    try {
      const u = await this.client.adoptWebSession(serverUrl, cookies);
      return this.afterLogin(u, serverUrl);
    } catch (e) {
      this.setConn("offline");
      throw e;
    }
  }

  private afterLogin(u: SessionUser, serverUrl: string): SessionUser {
    this.startXmpp(new URL(serverUrl).hostname);
    this.emit("ready", u);
    void this.refreshRooms().catch(() => undefined);
    this.startPolling();
    this.portal.start();
    return u;
  }

  /** Stop realtime without invalidating the server session (app quit). */
  shutdown() {
    this.portal.stop();
    this.stopPolling();
    this.xmppGen++;
    this.xmpp?.stop();
    this.xmpp = null;
    this.transport = null;
  }

  async logout(reason?: string) {
    this.portal.reset();
    this.stopPolling();
    this.xmppGen++;
    this.xmpp?.stop();
    this.xmpp = null;
    this.transport = null;
    await this.client.logout();
    this.rooms.clear();
    this.presence.clear();
    this.lastIds.clear();
    this.emitted.clear();
    this.usersCache = this.deptCache = null;
    this.setConn("offline");
    this.emit("loggedOut", { reason });
  }

  private setConn(state: ConnState, error?: string) {
    this.conn = state;
    this.emit("connection", { state, error });
  }

  /** XMPP credentials for BOSH as the web gets them (GET /api/bosh/user → jid + subInfo); derived key as fallback. */
  private async boshCreds(): Promise<{ username: string; password: string; domain: string }> {
    const u = this.client.user!;
    try {
      const res = await this.client.request("/api/bosh/user", { method: "GET" });
      const d = JSON.parse(res.text)?.data;
      if (res.status === 200 && d?.jid && d?.subInfo) {
        const [local, domain] = String(d.jid).split("@");
        return { username: local, password: String(d.subInfo), domain: domain || this.client.xmppDomain };
      }
    } catch {
      /* fall through */
    }
    return { username: String(u.repId), password: xmppKeyFromLoginId(this.client.loginIdForXmpp()), domain: this.client.xmppDomain };
  }

  private startXmpp(host: string, forceTcp = false) {
    this.xmppGen++;
    this.xmpp?.stop();
    this.xmpp = null;
    this.transport = null;
    if (forceTcp) return this.attachXmpp(new XmppClient({
      host,
      port: 5222,
      domain: this.client.xmppDomain,
      username: String(this.client.user!.repId),
      password: xmppKeyFromLoginId(this.client.loginIdForXmpp()),
      resource: this.client.resource,
    }), "tcp");
    const gen = ++this.xmppGen;
    void this.boshCreds().then((c) => {
      if (gen !== this.xmppGen || !this.client.user) return;
      const url = `${this.client.baseUrl}/http-bind/`;
      const x = new BoshClient({ url, domain: c.domain, username: c.username, password: c.password, resource: this.client.resource });
      x.on("state", (st: string) => {
        if (st === "offline" && !x.everOnline && this.allowTcpFallback && x.failuresBeforeOnline >= this.tcpFallbackAfter && this.xmpp === x) {
          this.log(`realtime: BOSH failed ${x.failuresBeforeOnline}x, falling back to TCP 5222 (plaintext, enabled in settings)`);
          this.startXmpp(host, true);
        }
      });
      this.attachXmpp(x, "bosh");
    });
  }
  private xmppGen = 0;

  private attachXmpp(x: XmppClient | BoshClient, transport: "bosh" | "tcp") {
    this.transport = transport;
    this.log(transport === "bosh" ? `realtime transport: BOSH (XMPP over HTTPS ${this.client.baseUrl}/http-bind/)` : `realtime transport: TCP 5222 (plaintext fallback)`);
    let wasOnline = false;
    x.on("state", (s: string, err?: string) => {
      if (s !== "connecting") this.log(`realtime ${transport}: ${s}${err ? ` (${err})` : ""}`);
      if (s === "online") {
        this.setConn("online");
        // catch up on anything missed while disconnected
        if (wasOnline) void this.sync("reconnect");
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
    x.on("body", (obj: Record<string, any>) => {
      if (process.env.UBION_DEBUG_REALTIME) this.log(`realtime ${transport}: stanza type=${String(obj?.type)} subtype=${String(obj?.subtype ?? "")}`);
      this.onBody(obj);
    });
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
      if (r.receipt) {
        // I read this room on another client (official app / mobile): clear its unread badge now
        if (r.receipt.readerSeq === me) {
          const room = this.rooms.get(r.receipt.roomKey);
          if (room && room.unread) {
            room.unread = 0;
            this.emitRooms();
          }
          this.scheduleSync();
        }
        this.emit("confirm", r.receipt);
      }
      return;
    }
    if (!r.isChat || r.seq == null || Number.isNaN(r.seq) || r.kind === "unknown") {
      // unknown/notification-only stanza: reconcile via REST
      if (r.type !== "noti" && r.type !== "presence") this.scheduleSync();
      return;
    }
    const key = `${r.kind}:${r.seq}`;
    const msg = { ...r.msg, roomKey: key };
    // REST is the source of truth: always reconcile the room shortly after any realtime hint
    this.scheduleRoomSync(key);
    if (msg.messageId != null && this.emitted.has(msg.messageId)) return;
    this.markEmitted(key, msg.messageId);
    const room = this.rooms.get(key);
    if (msg.needConfirmCount == null) msg.needConfirmCount = initialNeedConfirm(r.kind, r.seq, me, room);
    msg.confirmUsers = [];
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

  private markEmitted(key: string, id?: number) {
    if (id == null) return;
    this.emitted.add(id);
    if (this.emitted.size > 5000) this.emitted = new Set([...this.emitted].slice(-2500));
    if (id > (this.lastIds.get(key) || 0)) this.lastIds.set(key, id);
  }

  /** Called by the UI when a room's history was loaded, so polling only emits newer messages. */
  noteSeen(key: string, messages: ChatMessage[]) {
    for (const m of messages) this.markEmitted(key, m.messageId);
  }

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.sync("poll"), this.pollMs);
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const t of this.roomSyncTimers.values()) clearTimeout(t);
    this.roomSyncTimers.clear();
  }

  private scheduleSync() {
    this.scheduleRoomSync("*");
  }

  private scheduleRoomSync(key: string, delay = 1200) {
    if (this.roomSyncTimers.has(key)) return;
    this.roomSyncTimers.set(
      key,
      setTimeout(() => {
        this.roomSyncTimers.delete(key);
        void (key === "*" ? this.sync("hint") : this.syncRoom(key).then(() => this.refreshRooms()).catch(() => undefined));
      }, delay)
    );
  }

  /**
   * Robust fallback independent of XMPP routing: refresh the room list over REST,
   * then fetch new messages (messageId > last delivered) for the open room and any room whose
   * latest messageId advanced, emitting them as normal "message" events (deduped).
   */
  sync(_reason = "poll"): Promise<void> {
    if (!this.client.user) return Promise.resolve();
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const before = new Map([...this.rooms.values()].map((r) => [r.key, r.messageId || 0]));
      const hadRooms = before.size > 0;
      await this.refreshRooms();
      const changed = this.getRooms().filter((r) => hadRooms && (r.messageId || 0) > (before.get(r.key) || 0));
      const targets = new Set(changed.slice(0, 8).map((r) => r.key));
      if (this.activeRoomKey) targets.add(this.activeRoomKey);
      for (const key of targets) await this.syncRoom(key, before.get(key));
    })()
      .catch(() => undefined)
      .finally(() => {
        this.syncing = null;
      });
    return this.syncing;
  }

  /** Fetch latest page of a room and emit messages newer than what listeners already have. */
  async syncRoom(key: string, baseline?: number): Promise<number> {
    const me = this.client.user?.id;
    if (me == null) return 0;
    const last = this.lastIds.get(key);
    const room = this.rooms.get(key);
    // never seen this room in this session: only establish a baseline, don't replay history
    if (last == null && baseline == null) {
      if (room?.messageId) this.lastIds.set(key, room.messageId);
      if (key !== this.activeRoomKey) return 0;
    }
    const page = await this.history(key, undefined, 40);
    const fresh = newerThan(page, last ?? baseline ?? room?.messageId ?? Infinity).filter((m) => m.messageId == null || !this.emitted.has(m.messageId));
    const { kind, seq } = this.parseKey(key);
    if (key === this.activeRoomKey) {
      const updates = page
        .filter((m) => m.messageId != null && m.needConfirmCount != null)
        .map((m) => ({ messageId: m.messageId!, needConfirmCount: m.needConfirmCount!, confirmUsers: m.confirmUsers || [] }));
      if (updates.length) this.emit("receipts", { roomKey: key, updates });
    }
    for (const m of fresh) {
      this.markEmitted(key, m.messageId);
      const isMine = m.sendUserSeq === me;
      this.emit("message", { ...m, roomKey: key, roomKind: kind, roomSeq: seq, isMine, usePush: room ? room.usePush : true });
    }
    if (fresh.length && room) {
      const lastMsg = fresh[fresh.length - 1];
      room.preview = lastMsg.attach ? `📎 ${lastMsg.attach.name}` : lastMsg.message.slice(0, 200);
      room.messageId = Math.max(room.messageId || 0, lastMsg.messageId || 0);
      room.createdAt = lastMsg.createdAt || room.createdAt;
      this.emitRooms();
    }
    return fresh.length;
  }

  private emitRooms() {
    this.emit("rooms", this.getRooms());
  }

  getRooms(): Room[] {
    return sortRooms([...this.rooms.values()]);
  }

  unreadTotal(): number {
    let n = 0;
    // official app: every room's server unreadMessageCount is shown as its badge, muted or not
    for (const r of this.rooms.values()) n += r.unread;
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
    this.markEmitted(key, res.messageId);
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
  async members(key: string): Promise<RoomMember[]> {
    const { kind, seq } = this.parseKey(key);
    if (kind !== "room") return [];
    return this.client.listMembers(seq);
  }

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
    const me = this.client.user?.id;
    if (me != null) this.emit("confirm", { roomKey: key, readerSeq: me, endId: mid });
  }

  setActiveRoom(key: string | null) {
    this.activeRoomKey = key;
  }

  /** Window focus / visibility regained: catch up immediately. */
  onFocus() {
    this.focused = true;
    void this.sync("focus");
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

/** Messages with numeric id strictly greater than `after`, ascending. Pure; unit-tested. */
export function newerThan(list: ChatMessage[], after: number): ChatMessage[] {
  return list
    .filter((m) => m.messageId != null && m.messageId > after)
    .sort((a, b) => (a.messageId || 0) - (b.messageId || 0));
}

/** Official getNeedConfirmCount(): group → members-1, 1:1 → 1, own memo room / pubsub → 0. */
export function initialNeedConfirm(kind: RoomKind, seq: number, me: number, room?: Room): number {
  if (kind === "room") return Math.max(0, (room?.memberCount || 1) - 1);
  if (kind === "buddy") return seq === me ? 0 : 1;
  return 0;
}
