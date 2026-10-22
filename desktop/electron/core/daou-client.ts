import { CookieJar } from "tough-cookie";
import type { AttachModel, ChatMessage, Department, RoomMember, LoginOptions, Person, Room, RoomKind, SessionUser } from "./types";
import { canonMessageId, ensureTimestamp } from "./messages";
import { classify, diagLine, diagnose, isPendingRedirect, userMessage } from "./login-errors";

type ReqInit = {
  method?: string;
  json?: unknown;
  form?: Record<string, string>;
  body?: Buffer;
  contentType?: string;
  retry?: boolean;
};
type Res = { status: number; text: string; buffer: Buffer; contentType: string };

export class HttpError extends Error {
  constructor(public status: number, msg: string, public diag?: string) {
    super(msg);
  }
}

const PATH_KIND: Record<string, string> = { buddy: "chat/buddies", room: "chat/rooms", pubsub: "chat/pubsubs" };
const ROOM_TYPE: Record<string, string> = { buddy: "single", room: "room", pubsub: "pubsub" };

/**
 * DaouOffice (Group Office) REST client, cookie SSO (GOSSOcookie).
 * Endpoints mirrored from the official UBIONMessenger renderer bundle.
 * Never logs credentials or cookies.
 */
export class DaouClient {
  baseUrl: string;
  jar = new CookieJar();
  user: SessionUser | null = null;
  xmppDomain = "xmppdaou.com";
  resource = "";
  private companies: Array<{ userId: number; userLoginId: string }> = [];
  private creds: LoginOptions | null = null;
  private relogin: Promise<void> | null = null;
  /** Called after every successful (re-)login and after logout, so the in-app portal window can resync cookies. */
  onSessionChanged: (() => void) | null = null;

  constructor(baseUrl = "https://coco.ubion.co.kr") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  // ---------- auth ----------
  async login(opts: LoginOptions): Promise<SessionUser> {
    this.baseUrl = opts.serverUrl.replace(/\/$/, "");
    this.creds = opts;
    await this.doLogin();
    return this.fetchSession();
  }

  private async doLogin() {
    if (!this.creds) throw new HttpError(401, "no credentials");
    const res = await this.request(
      "/api/login",
      {
        method: "POST",
        json: { username: this.creds.username, password: this.creds.password, captcha: "", returnUrl: "" },
        retry: false,
      }
    );
    const d = diagnose(res.status, res.text, "/api/login");
    let body: any = null;
    try {
      body = JSON.parse(res.text);
    } catch {
      /* html */
    }
    const flags = Object.entries(body?.data || {})
      .filter(([k, v]) => v === true && /otp|pwd|password|change|expire|lock|device|captcha/i.test(k) && k !== "useSkipPwdChange")
      .map(([k]) => k);
    if (res.status !== 200 || (body && body.code && String(body.code) !== "200")) {
      throw new HttpError(res.status === 200 ? 401 : res.status, userMessage(d, classify(d, flags)), diagLine(d));
    }
    // 200 but redirected to a pending step (pw change / OTP / device approval): session is not usable yet.
    if (isPendingRedirect(d.redirect) || flags.length) {
      const issue = classify(d, flags) ?? "unknown";
      throw new HttpError(403, userMessage(d, issue), diagLine(d) + (flags.length ? ` flags=${flags.join(",")}` : ""));
    }
    if (body?.data?.xmppDomain) this.xmppDomain = body.data.xmppDomain;
    try { this.onSessionChanged?.(); } catch { /* ignore */ }
  }

  /** Cookies the jar would send to the portal origin (GOSSOcookie etc.). Values must never be logged. */
  async sessionCookies() {
    return this.jar.getCookies(this.baseUrl + "/");
  }

  /** Cookie refresh: re-login once with remembered credentials (coalesced). */
  private async refreshSession() {
    if (!this.relogin) {
      this.relogin = this.doLogin().finally(() => {
        this.relogin = null;
      });
    }
    return this.relogin;
  }

  async fetchSession(): Promise<SessionUser> {
    const data = (await this.getJson("/api/user/session")).data;
    this.user = {
      id: Number(data.id),
      repId: Number(data.repId ?? data.id),
      name: String(data.name || ""),
      loginId: String(data.loginId || ""),
      companyId: Number(data.companyId ?? data.companies?.[0]?.id),
      thumbnail: data.thumbnail,
      position: data.position,
    };
    this.companies = data.companies || [];
    if (!this.resource) this.resource = `go_pc_${this.user.id}_${Math.floor(Math.random() * 900 + 100)}_ubion`;
    return this.user;
  }

  async logout() {
    try {
      await this.request("/api/logout", { method: "GET", retry: false });
    } catch {
      /* ignore */
    }
    this.jar = new CookieJar();
    this.user = null;
    this.creds = null;
    try { this.onSessionChanged?.(); } catch { /* ignore */ }
  }

  loginIdForXmpp(): string {
    const u = this.requireUser();
    const co = this.companies.find((c) => Number(c.userId) === u.repId);
    return co?.userLoginId || u.loginId;
  }

  // ---------- rooms ----------
  async listRooms(): Promise<Room[]> {
    const uid = this.requireUser().id;
    const out: Room[] = [];
    for (let page = 0; page < 25; page++) {
      const body = await this.getJson(`/api/chat/new/buddies?offset=40&page=${page}&userSeq=${uid}`);
      const chunk = body.data || [];
      out.push(...chunk.map((r: Record<string, unknown>) => this.normalizeRoom(r)));
      if (!body.hasNext || !chunk.length) break;
    }
    return sortRooms(dedupeRooms(out));
  }

  normalizeRoom(r: Record<string, any>): Room {
    const uid = this.user?.id;
    let kind: RoomKind = "unknown";
    let seq = 0;
    // official: buddyRoomType "single" | "my" (memo-to-self), roomType "group" | "pubsub"
    if (r.buddySeq != null) {
      kind = "buddy";
      seq = Number(r.buddySeq);
    } else if (r.pubsubSeq != null || r.roomType === "pubsub") {
      kind = "pubsub";
      seq = Number(r.pubsubSeq ?? r.roomSeq);
    } else if (r.roomSeq != null) {
      kind = "room";
      seq = Number(r.roomSeq);
    }
    return {
      key: `${kind}:${seq}`,
      kind,
      seq,
      name: String(r.chatRoomName || r.buddyName || r.memberName || "(이름 없음)"),
      preview: String(r.message || "").slice(0, 200),
      messageId: canonMessageId(r.messageId),
      unread: Number(r.unreadMessageCount || 0),
      createdAt: r.createdAt ? String(r.createdAt) : undefined,
      usePin: !!r.usePin,
      usePush: r.usePush !== false,
      avatar: String(r.userImage || ""),
      memberCount: r.memberCount != null ? Number(r.memberCount) : undefined,
      isSelf: kind === "buddy" && (seq === uid || r.buddyRoomType === "my"),
      peerUserId: kind === "buddy" ? seq : undefined,
      position: r.buddyPosition ? String(r.buddyPosition) : undefined,
    };
  }

  // ---------- messages ----------
  async fetchMessages(kind: RoomKind, seq: number, size = 40, before?: number): Promise<ChatMessage[]> {
    const uid = this.requireUser().id;
    const p = PATH_KIND[kind];
    if (!p) return [];
    let path = `/api/${p}/${seq}?size=${size}&userSeq=${uid}`;
    if (before) path += `&criteriaMessageId=${before}`;
    const body = await this.getJson(path);
    return (body.data || []).map((m: Record<string, unknown>) => normalizeRestMessage(m, `${kind}:${seq}`));
  }

  async searchMessages(kind: RoomKind, seq: number, keyword: string, page = 0): Promise<ChatMessage[]> {
    const uid = this.requireUser().id;
    const body = await this.getJson(
      `/api/chat/${seq}/search?offset=30&page=${page}&keyword=${encodeURIComponent(keyword)}&userSeq=${uid}&roomType=${ROOM_TYPE[kind]}`
    );
    return (body.data || []).map((m: Record<string, unknown>) => normalizeRestMessage(m, `${kind}:${seq}`));
  }

  async sendMessage(
    kind: RoomKind,
    seq: number,
    text: string,
    extra: Record<string, string> = {}
  ): Promise<{ messageId?: number }> {
    const uid = this.requireUser().id;
    const p = PATH_KIND[kind];
    if (!p) throw new Error("이 대화방에는 보낼 수 없습니다");
    const form: Record<string, string> = {
      resource: this.resource,
      userSeq: String(uid),
      tempMessageId: String(Date.now() + Math.random()),
      ...extra,
    };
    if (text) form.message = text;
    const body = await this.getJson(`/api/${p}/${seq}`, { method: "POST", form });
    return { messageId: canonMessageId((body.data || body).messageId) };
  }

  /** Same flow as official client: POST /api/chat/files (multipart "file") → cryptId → send with cryptAttachText. */
  async sendFile(kind: RoomKind, seq: number, file: { name: string; data: Buffer; mime?: string }) {
    const u = this.requireUser();
    const tmp = `${file.name}_${Date.now()}`;
    const boundary = "----UBIONForm" + Math.random().toString(16).slice(2);
    const safeName = file.name.replace(/"/g, "_");
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
          `Content-Type: ${file.mime || "application/octet-stream"}\r\n\r\n`,
        "utf8"
      ),
      file.data,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]);
    const up = await this.getJson(
      `/api/chat/files?companyId=${u.companyId}&userSeq=${u.id}&messageId=${encodeURIComponent(tmp)}`,
      { method: "POST", body, contentType: `multipart/form-data; boundary=${boundary}` }
    );
    const cryptId = up?.data?.cryptId;
    if (!cryptId) throw new Error("업로드 응답에 cryptId 없음");
    return this.sendMessage(kind, seq, "", { tempMessageId: tmp, path: file.name, cryptAttachText: String(cryptId) });
  }

  async markRead(kind: RoomKind, seq: number, messageId: number): Promise<void> {
    const uid = this.requireUser().id;
    const p = PATH_KIND[kind];
    if (!p || !messageId) return;
    await this.request(`/api/${p}/${seq}/${messageId}/before?userSeq=${uid}`, { method: "PUT" });
  }

  async setPin(room: Room, pin: boolean) {
    const uid = this.requireUser().id;
    const base = pin ? "attachpin" : "detachpin";
    await this.request(`/api/chat/${base}/${room.seq}?roomType=${ROOM_TYPE[room.kind]}&userSeq=${uid}`, { method: "PUT" });
  }

  // ---------- org ----------
  async listUsers(): Promise<Person[]> {
    const cid = this.requireUser().companyId;
    const body = await this.getJson(`/api/users/accessible/entire?companyId=${cid}`);
    return (body.data || [])
      .filter((u: any) => u.status !== "dormant" && u.status !== "deleted")
      .map((u: any) => ({
        userId: Number(u.userId ?? u.repId),
        name: String(u.name || ""),
        position: String(u.position || ""),
        email: String(u.email || ""),
        thumbnail: String(u.thumbnail || ""),
        departmentIds: (u.departmentIds || []).map(Number),
        directTel: u.directTel || undefined,
        mobileNo: u.mobileNo || undefined,
      }));
  }

  /** Org tree: names from /departments/tiny, structure + membership from /departments/children. */
  async listDepartments(): Promise<Department[]> {
    const u = this.requireUser();
    const [tiny, rel] = await Promise.all([
      this.getJson(`/api/departments/tiny?companyId=${u.companyId}&page=0&offset=13000&userSeq=${u.id}`),
      this.getJson(`/api/departments/children?companyId=${u.companyId}&page=0&offset=10000&userSeq=${u.id}`).catch(() => ({ data: [] })),
    ]);
    const map = new Map<number, Department>();
    for (const d of tiny.data || []) {
      if (d.deleted) continue;
      map.set(Number(d.id), { id: Number(d.id), name: String(d.name || ""), sortOrder: Number(d.sortOrder || 0), memberIds: [] });
    }
    for (const node of rel.data || []) {
      const id = Number(node.id);
      const dep = map.get(id);
      if (dep) dep.memberIds = (node.deptMembers || []).map((m: any) => Number(m.userId));
      for (const c of node.depts || []) {
        const child = map.get(Number(c.id));
        if (child) child.parentId = id;
      }
    }
    // depth-first order for tree display
    const kids = new Map<number | undefined, Department[]>();
    for (const d of map.values()) {
      const pid = d.parentId != null && map.has(d.parentId) ? d.parentId : undefined;
      kids.set(pid, [...(kids.get(pid) || []), d]);
    }
    const out: Department[] = [];
    const walk = (pid: number | undefined, depth: number) => {
      for (const d of (kids.get(pid) || []).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ko"))) {
        out.push({ ...d, depth });
        walk(d.id, depth + 1);
      }
    };
    walk(undefined, 0);
    return out;
  }

  async listMembers(roomSeq: number): Promise<RoomMember[]> {
    const uid = this.requireUser().id;
    const body = await this.getJson(`/api/chat/members/${roomSeq}?userSeq=${uid}`);
    return (body.data || []).map((m: any) => ({
      userId: Number(m.memberSeq ?? m.userId),
      name: String(m.memberName || m.name || ""),
      image: String(m.memberImage || ""),
      position: String(m.jobTitle || ""),
    }));
  }

  async createGroupRoom(memberIds: number[]): Promise<number> {
    const uid = this.requireUser().id;
    const qs = memberIds.map((id) => `memberSeq=${id}`).join("&");
    const body = await this.getJson(`/api/chat/rooms?${qs}&userSeq=${uid}`, { method: "POST", json: {} });
    return Number(body.data.roomSeq);
  }

  // ---------- files ----------
  fileUrlPath(cryptId: string, messageId: number | undefined) {
    const uid = this.requireUser().id;
    return `/api/chat/files/${encodeURIComponent(cryptId)}?userSeq=${uid}${messageId ? `&messageId=${messageId}` : ""}`;
  }

  /** Authenticated GET of any same-server path (thumbnails, avatars, files). */
  async fetchBinary(path: string): Promise<{ data: Buffer; contentType: string }> {
    if (!path.startsWith("/")) path = "/" + path;
    const res = await this.request(path);
    if (res.status !== 200) throw new HttpError(res.status, `GET ${res.status}`);
    return { data: res.buffer, contentType: res.contentType };
  }

  // ---------- http ----------
  private requireUser(): SessionUser {
    if (!this.user) throw new HttpError(401, "not logged in");
    return this.user;
  }

  private async getJson(path: string, init: ReqInit = {}): Promise<any> {
    const res = await this.request(path, init);
    if (res.status !== 200) {
      const d = diagnose(res.status, res.text, path.split("?")[0]);
      if (path.startsWith("/api/user/session")) throw new HttpError(res.status, userMessage(d, classify(d)), diagLine(d));
      throw new HttpError(res.status, d.message ? `${d.message} (${diagLine(d)})` : diagLine(d), diagLine(d));
    }
    try {
      return JSON.parse(res.text);
    } catch {
      throw new HttpError(500, "invalid JSON");
    }
  }

  async request(path: string, init: ReqInit = {}): Promise<Res> {
    const res = await this.rawRequest(path, init);
    if (res.status === 401 && init.retry !== false && this.creds) {
      await this.refreshSession();
      return this.rawRequest(path, init);
    }
    return res;
  }

  private async rawRequest(path: string, init: ReqInit): Promise<Res> {
    const url = this.baseUrl + path;
    const headers: Record<string, string> = {
      "User-Agent": "UBIONMessenger-Desktop/1.0",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/javascript, */*; q=0.01",
    };
    const cookie = await this.jar.getCookieString(url);
    if (cookie) headers.Cookie = cookie;
    let body: Buffer | undefined;
    if (init.form) {
      body = Buffer.from(new URLSearchParams(init.form).toString(), "utf8");
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    } else if (init.json !== undefined) {
      body = Buffer.from(JSON.stringify(init.json), "utf8");
      headers["Content-Type"] = "application/json";
    } else if (init.body) {
      body = init.body;
      if (init.contentType) headers["Content-Type"] = init.contentType;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), body && body.length > 1e6 ? 300_000 : 30_000);
    try {
      const res = await fetch(url, {
        method: init.method || (body ? "POST" : "GET"),
        headers,
        body,
        redirect: "manual",
        signal: ctrl.signal,
      });
      for (const c of res.headers.getSetCookie?.() || []) {
        try {
          await this.jar.setCookie(c, url);
        } catch {
          /* ignore */
        }
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // Server answers unauthenticated page requests with redirect to /login
      const loc = res.headers.get("location") || "";
      if (res.status >= 300 && res.status < 400 && loc && !/login/i.test(loc) && (init.method || "GET") === "GET") {
        const next = new URL(loc, url);
        if (next.origin === new URL(url).origin) return this.rawRequest(next.pathname + next.search, init);
      }
      const status = res.status >= 300 && res.status < 400 ? 401 : res.status;
      return { status, text: buf.toString("utf8"), buffer: buf, contentType: res.headers.get("content-type") || "application/octet-stream" };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function normalizeRestMessage(m: Record<string, any>, roomKey?: string): ChatMessage {
  const a = m.chatMessageAttachFileModel;
  const attach: AttachModel | undefined =
    a && a.cryptId
      ? {
          cryptId: String(a.cryptId),
          name: String(a.name || m.message || "file"),
          extention: a.extention,
          size: a.size != null ? Number(a.size) : undefined,
          imageFile: !!a.imageFile,
          thumbSmall: a.thumbSmall,
          thumbMid: a.thumbMid,
          thumbLarge: a.thumbLarge,
          thumbOriginal: a.thumbOriginal,
        }
      : undefined;
  return ensureTimestamp({
    messageId: canonMessageId(m.messageId),
    roomKey,
    sendUserSeq: m.sendUserSeq != null ? Number(m.sendUserSeq) : undefined,
    sendUserName: String(m.sendUserName || ""),
    targetUserSeq: m.targetUserSeq != null ? Number(m.targetUserSeq) : undefined,
    message: String(m.message ?? ""),
    createdAt: m.createdAt ? String(m.createdAt) : undefined,
    userImage: String(m.userImage || ""),
    companyId: m.companyId != null ? Number(m.companyId) : undefined,
    confirmCount: m.confirmCount != null ? Number(m.confirmCount) : undefined,
    needConfirmCount: m.needConfirmCount != null ? Number(m.needConfirmCount) : undefined,
    confirmUsers: Array.isArray(m.confirmUsers)
      ? m.confirmUsers.map((u: any) => Number(typeof u === "object" && u ? u.userSeq ?? u.id : u)).filter(Number.isFinite)
      : undefined,
    attach,
    messageType: m.messageType ? String(m.messageType) : attach ? "SENDFILE" : "TEXT",
  });
}

export function dedupeRooms(rooms: Room[]): Room[] {
  const m = new Map<string, Room>();
  for (const r of rooms) if (!m.has(r.key)) m.set(r.key, r);
  return [...m.values()];
}

export function roomTime(r: Room): number {
  const t = r.createdAt ? new Date(r.createdAt).getTime() : NaN;
  return Number.isNaN(t) ? r.messageId || 0 : t;
}

export function sortRooms(rooms: Room[]): Room[] {
  return [...rooms].sort((a, b) => Number(b.usePin) - Number(a.usePin) || roomTime(b) - roomTime(a));
}
