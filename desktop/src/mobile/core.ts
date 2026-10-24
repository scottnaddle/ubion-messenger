/**
 * Renderer-side messenger core for the mobile build: DaouClient over the platform HTTP adapter,
 * realtime replaced by REST polling (no XMPP/BOSH yet). Emits the same event types/payloads that
 * electron/core/messenger.ts forwards to the renderer ("rooms", "message", "connection", …).
 * Mirrors MessengerCore's sync/syncRoom semantics; importing messenger.ts itself would drag in node:net.
 */
import { DaouClient, sortRooms } from "../../electron/core/daou-client";
import type { ChatMessage, ConnState, Department, LoginOptions, Person, Room, RoomKind, RoomMember, SessionUser } from "../../electron/core/types";
import type { HttpFetch } from "../platform/http";

export type CoreEvent = { type: string; payload: any };
type Listener = (e: CoreEvent) => void;

/** Messages with numeric id strictly greater than `after`, ascending (same as messenger.ts newerThan). */
export function newerThan(list: ChatMessage[], after: number): ChatMessage[] {
  return list
    .filter((m) => m.messageId != null && m.messageId > after)
    .sort((a, b) => (a.messageId || 0) - (b.messageId || 0));
}

export type MobileCoreOptions = {
  fetch: HttpFetch;
  pollMs?: number;
  /** Test seam: build the REST client. */
  createClient?: (serverUrl?: string) => DaouClient;
};

export class MobileCore {
  client: DaouClient;
  conn: ConnState = "offline";
  activeRoomKey: string | null = null;
  focused = true;
  pollMs: number;
  private listeners = new Set<Listener>();
  private rooms = new Map<string, Room>();
  private lastIds = new Map<string, number>();
  private emitted = new Set<number>();
  private usersCache: Person[] | null = null;
  private deptCache: Department[] | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<void> | null = null;
  private readonly fetchImpl: HttpFetch;
  private readonly makeClient: (serverUrl?: string) => DaouClient;

  constructor(opts: MobileCoreOptions) {
    this.fetchImpl = opts.fetch;
    this.pollMs = opts.pollMs ?? 15_000;
    this.makeClient = opts.createClient ?? ((u) => new DaouClient(u));
    this.client = this.newClient();
  }

  private newClient(serverUrl?: string): DaouClient {
    const c = this.makeClient(serverUrl);
    c.fetchImpl = this.fetchImpl;
    c.onAuthLost = () => {
      this.stopPolling();
      this.emit("webLoginRequired", { reason: "expired", message: "세션이 만료되었어요. 다시 로그인해 주세요" });
    };
    return c;
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  emit(type: string, payload: unknown) {
    for (const l of [...this.listeners]) {
      try {
        l({ type, payload });
      } catch {
        /* a failing UI listener must not break the core */
      }
    }
  }

  get user(): SessionUser | null {
    return this.client.user;
  }

  private setConn(state: ConnState, error?: string) {
    if (this.conn === state && !error) return;
    this.conn = state;
    this.emit("connection", { state, error });
  }

  async login(opts: LoginOptions): Promise<SessionUser> {
    if (this.client.user) await this.logout();
    this.reset();
    this.client = this.newClient(opts.serverUrl);
    this.setConn("connecting");
    try {
      const u = await this.client.login(opts);
      this.emit("ready", u);
      // REST polling is our "realtime": online once the first room list arrives.
      await this.refreshRooms().then(() => this.setConn("online")).catch(() => this.setConn("reconnecting"));
      this.startPolling();
      return u;
    } catch (e) {
      this.setConn("offline");
      throw e;
    }
  }

  async logout(reason = "user") {
    this.stopPolling();
    await this.client.logout();
    this.reset();
    this.setConn("offline");
    this.emit("loggedOut", { reason });
  }

  private reset() {
    this.rooms.clear();
    this.lastIds.clear();
    this.emitted.clear();
    this.usersCache = this.deptCache = null;
    this.activeRoomKey = null;
  }

  // ---------- polling ----------
  startPolling() {
    this.stopPolling();
    if (!this.focused) return;
    this.pollTimer = setInterval(() => void this.sync("poll"), this.pollMs);
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  get polling(): boolean {
    return this.pollTimer != null;
  }

  /** App foreground/background: poll only while visible; catch up immediately on return. */
  setForeground(fg: boolean) {
    this.focused = fg;
    if (!this.client.user) return;
    if (fg) {
      this.startPolling();
      void this.sync("focus");
    } else this.stopPolling();
  }

  /** Room list + new messages for the open room and rooms whose latest id advanced (deduped). */
  sync(_reason = "poll"): Promise<void> {
    if (!this.client.user) return Promise.resolve();
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const before = new Map([...this.rooms.values()].map((r) => [r.key, r.messageId || 0]));
      const hadRooms = before.size > 0;
      try {
        await this.refreshRooms();
        this.setConn("online");
      } catch (e) {
        this.setConn("reconnecting");
        throw e;
      }
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

  async syncRoom(key: string, baseline?: number): Promise<number> {
    const me = this.client.user?.id;
    if (me == null) return 0;
    const last = this.lastIds.get(key);
    const room = this.rooms.get(key);
    if (last == null && baseline == null) {
      if (room?.messageId) this.lastIds.set(key, room.messageId);
      if (key !== this.activeRoomKey) return 0;
    }
    const page = await this.history(key, undefined, 40);
    const fresh = newerThan(page, last ?? baseline ?? room?.messageId ?? Infinity).filter(
      (m) => m.messageId == null || !this.emitted.has(m.messageId),
    );
    const { kind, seq } = parseKey(key);
    if (key === this.activeRoomKey) {
      const updates = page
        .filter((m) => m.messageId != null && m.needConfirmCount != null)
        .map((m) => ({ messageId: m.messageId!, needConfirmCount: m.needConfirmCount!, confirmUsers: m.confirmUsers || [] }));
      if (updates.length) this.emit("receipts", { roomKey: key, updates });
    }
    for (const m of fresh) {
      this.markEmitted(key, m.messageId);
      this.emit("message", { ...m, roomKey: key, roomKind: kind, roomSeq: seq, isMine: m.sendUserSeq === me, usePush: room ? room.usePush : true });
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

  private markEmitted(key: string, id?: number) {
    if (id == null) return;
    this.emitted.add(id);
    if (this.emitted.size > 5000) this.emitted = new Set([...this.emitted].slice(-2500));
    if (id > (this.lastIds.get(key) || 0)) this.lastIds.set(key, id);
  }

  noteSeen(key: string, messages: ChatMessage[]) {
    for (const m of messages) this.markEmitted(key, m.messageId);
  }

  // ---------- rooms ----------
  private emitRooms() {
    this.emit("rooms", this.getRooms());
  }

  getRooms(): Room[] {
    return sortRooms([...this.rooms.values()]);
  }

  unreadTotal(): number {
    let n = 0;
    for (const r of this.rooms.values()) n += r.unread;
    return n;
  }

  async refreshRooms(): Promise<Room[]> {
    const list = await this.client.listRooms();
    // keep locally opened 1:1 rooms the server does not list yet
    const local = [...this.rooms.values()].filter((r) => r.kind === "buddy" && !r.messageId && !list.some((x) => x.key === r.key));
    this.rooms = new Map([...list, ...local].map((r) => [r.key, r]));
    if (this.activeRoomKey && this.focused) {
      const a = this.rooms.get(this.activeRoomKey);
      if (a) a.unread = 0;
    }
    this.emitRooms();
    return this.getRooms();
  }

  setActiveRoom(key: string | null) {
    this.activeRoomKey = key;
  }

  history(key: string, before?: number, size = 40) {
    const { kind, seq } = parseKey(key);
    return this.client.fetchMessages(kind, seq, size, before);
  }

  searchInRoom(key: string, keyword: string) {
    const { kind, seq } = parseKey(key);
    return this.client.searchMessages(kind, seq, keyword);
  }

  async sendText(key: string, text: string) {
    const { kind, seq } = parseKey(key);
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

  async markRead(key: string, messageId?: number) {
    const room = this.rooms.get(key);
    const mid = messageId ?? room?.messageId;
    if (room && room.unread) {
      room.unread = 0;
      this.emitRooms();
    }
    if (!mid) return;
    const { kind, seq } = parseKey(key);
    await this.client.markRead(kind, seq, mid);
    const me = this.client.user?.id;
    if (me != null) this.emit("confirm", { roomKey: key, readerSeq: me, endId: mid });
  }

  async setPin(key: string, pin: boolean) {
    const room = this.rooms.get(key);
    if (!room) return;
    await this.client.setPin(room, pin);
    room.usePin = pin;
    this.emitRooms();
  }

  async members(key: string): Promise<RoomMember[]> {
    const { kind, seq } = parseKey(key);
    if (kind !== "room") return [];
    return this.client.listMembers(seq);
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

  async openDirect(userId: number): Promise<Room> {
    const key = `buddy:${userId}`;
    let room = this.rooms.get(key);
    if (!room) {
      const p = (await this.users()).find((u) => u.userId === userId);
      room = {
        key, kind: "buddy", seq: userId, name: p?.name || String(userId), preview: "", unread: 0,
        usePin: false, usePush: true, avatar: p?.thumbnail || "", isSelf: userId === this.user?.id,
        peerUserId: userId, position: p?.position,
      };
      this.rooms.set(key, room);
      this.emitRooms();
    }
    return room;
  }
}

export function parseKey(key: string): { kind: RoomKind; seq: number } {
  const [kind, seq] = String(key).split(":");
  return { kind: kind as RoomKind, seq: Number(seq) };
}
