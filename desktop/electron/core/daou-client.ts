import { CookieJar } from "tough-cookie";
import { normalizeAttach } from "./attach";
import type { AttachModel, ChatMessage, Department, RoomMember, LoginOptions, Person, Room, RoomKind, SessionUser } from "./types";
import { canonMessageId, ensureTimestamp } from "./messages";
import { chatDeleteBody, isDeletedMessage, normalizeChatDeleteIds, parseIsMessageDeletable } from "./chat-delete";
import { PATH_KIND, roomPushPath, ROOM_PUSH_METHOD } from "./room-push";
import { favoriteBody, favoritePath, parseFavorites } from "./favorites";
import { FORWARD_METHOD, forwardMembersPath, forwardRoomPath, normalizeForwardCryptIds } from "./forward";
import { parseNotice, roomNoticePath, ROOM_NOTICE_METHOD } from "./room-notice";
import {
  buildCircleBody, parsePubsubDetail, parsePubsubList, pubsubDeletePath, pubsubDetailPath, pubsubListPath,
  pubsubSendEnabled, pubsubSendPath, PUBSUB_SEND_DISABLED_TEXT, type PubsubDetail, type PubsubPage,
} from "./pubsub";
import {
  backupBodyError, backupDeletePath, backupDownloadPath, backupListPath, backupRequestPath, buildBackupRequest,
  HISTORY_CLEAR_METHOD, historyClearPath, parseBackupList, type BackupItem,
} from "./backup";
import {
  isZoomAuthError, parseMeeting, parseZoomConfig, ZOOM_CONFIG_PATH, ZOOM_DISABLED_TEXT, ZOOM_MEETING_METHOD, ZOOM_MEETING_PATH,
  zoomEnabled, zoomMeetingForm, type ZoomConfig, type ZoomMeeting,
} from "./zoom";
import { classify, diagLine, diagnose, isPendingRedirect, userMessage } from "./login-errors";
import { fromElectronCookie, needsWebLogin, onSessionExpired, WEB_LOGIN_MESSAGE, type ElectronCookieIn } from "./web-login";

type ReqInit = {
  method?: string;
  json?: unknown;
  form?: Record<string, string>;
  body?: Buffer;
  contentType?: string;
  accept?: string;
  retry?: boolean;
};
type Res = { status: number; text: string; buffer: Buffer; contentType: string };

/** Minimal fetch surface DaouClient needs (global fetch in Electron/Node; CapacitorHttp adapter on mobile). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array | string; redirect: "manual"; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null; getSetCookie?(): string[] };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export class HttpError extends Error {
  /** true → the account must finish login on the server's web page (OTP / 2-step / pending step). */
  webLogin = false;
  constructor(public status: number, msg: string, public diag?: string) {
    super(msg);
  }
}

const ROOM_TYPE: Record<string, string> = { buddy: "single", room: "room", pubsub: "pubsub" };

/**
 * Exact official create-group request path:
 * POST /api/chat/rooms?memberSeq=..&memberSeq=..&userSeq=<me>, JSON body.
 * Drops invalid ids and the caller's own id, and dedupes repeated members.
 */
export function buildCreateGroupRoomPath(memberIds: number[], userSeq: number): string {
  const me = Number(userSeq);
  const ids = [
    ...new Set(memberIds.map(Number).filter((id) => Number.isFinite(id) && id > 0 && id !== me)),
  ];
  if (!ids.length) throw new Error("대화 상대를 선택하세요");
  const qs = ids.map((id) => `memberSeq=${id}`).join("&");
  return `/api/chat/rooms?${qs}&userSeq=${me}`;
}

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
  /** Session came from the web-login window (no native credentials): on expiry prompt web login, never re-POST /api/login. */
  webSession = false;
  private authLostNotified = false;
  /** Called once when a web session expires (401). */
  onAuthLost: (() => void) | null = null;
  /** HTTP transport; resolves globalThis.fetch at call time so tests/stubs installed later still apply. */
  fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init as RequestInit);

  constructor(baseUrl = "https://coco.ubion.co.kr") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  // ---------- auth ----------
  async login(opts: LoginOptions): Promise<SessionUser> {
    this.baseUrl = opts.serverUrl.replace(/\/$/, "");
    this.creds = opts;
    this.webSession = false;
    await this.doLogin();
    try {
      return await this.fetchSession();
    } catch (e) {
      // 200 login but session check refused (seen with OTP accounts): offer web login.
      if (e instanceof HttpError && needsWebLogin({ phase: "session", status: e.status })) {
        const w = new HttpError(e.status, `${WEB_LOGIN_MESSAGE}\n${e.message}`, e.diag);
        w.webLogin = true;
        throw w;
      }
      throw e;
    }
  }

  /**
   * Adopt a cookie session completed in the web-login window. No credentials are kept,
   * so a later 401 triggers onAuthLost (web prompt) instead of native re-login loops.
   */
  async adoptWebSession(serverUrl: string, cookies: ElectronCookieIn[]): Promise<SessionUser> {
    this.baseUrl = serverUrl.replace(/\/$/, "");
    const jar = new CookieJar();
    const url = this.baseUrl + "/";
    for (const c of cookies) {
      try { await jar.setCookie(fromElectronCookie(c), url); } catch { /* foreign domain etc. */ }
    }
    this.jar = jar;
    this.creds = null;
    this.webSession = true;
    this.authLostNotified = false;
    const u = await this.fetchSession();
    try { this.onSessionChanged?.(); } catch { /* ignore */ }
    return u;
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
      const web = needsWebLogin({ phase: "login", status: 200, issue, pendingRedirect: isPendingRedirect(d.redirect), flags });
      const err = new HttpError(403, (web ? WEB_LOGIN_MESSAGE + "\n" : "") + userMessage(d, issue), diagLine(d) + (flags.length ? ` flags=${flags.join(",")}` : ""));
      err.webLogin = web;
      throw err;
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
      brandName: data.brandName ? String(data.brandName) : undefined,
      isMessageDeletable: parseIsMessageDeletable(data),
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
    this.webSession = false;
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
      buddyRoomSeq: r.buddyRoomSeq != null ? Number(r.buddyRoomSeq) : undefined,
      peerUserId: kind === "buddy" ? seq : undefined,
      position: r.buddyPosition ? String(r.buddyPosition) : undefined,
      notice: parseNotice(r.noticeMessage),
      noticeUpdatedAt: r.noticeMessage?.updatedAt ? String(r.noticeMessage.updatedAt) : undefined,
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

  /** 통합 검색: read-only GET, restricted to the per-room search / attaches list endpoints. */
  async searchGet(path: string): Promise<any> {
    this.requireUser();
    if (!/^\/api\/chat\/(\d+\/search\?|(buddies|rooms|pubsubs)\/attaches\/\d+\?)/.test(path)) throw new Error("허용되지 않은 검색 요청입니다");
    return this.getJson(path);
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

  /** ⚠ MUTATES server state: PUT /api/chat/message/delete?userSeq=<me> {"ids":[…]} → server tombstone. */
  async deleteChatMessages(ids: unknown): Promise<{ ok: true; count: number }> {
    const uid = this.requireUser().id;
    const list = normalizeChatDeleteIds(ids);
    const body = await this.getJson(`/api/chat/message/delete?userSeq=${uid}`, {
      method: "PUT",
      json: chatDeleteBody(list),
    });
    const code = body?.code;
    if (code != null && String(code) !== "200") {
      const n = Number(code);
      const status = Number.isInteger(n) && n >= 100 && n <= 599 ? n : 500;
      const msg = body?.message ?? body?.msg ?? body?.data?.message ?? `메시지 삭제 실패 (code ${code})`;
      throw new HttpError(status, String(msg));
    }
    return { ok: true, count: list.length };
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

  /** ⚠ MUTATES server state: PUT /api/{chat/buddies|chat/rooms|chat/pubsubs}/{seq}/push?userSeq=<me>&usePush=true|false, no body. */
  async setRoomPush(kind: RoomKind, roomSeq: number, usePush: boolean): Promise<void> {
    const uid = this.requireUser().id;
    const res = await this.request(roomPushPath(kind, roomSeq, uid, usePush), {
      method: ROOM_PUSH_METHOD,
      contentType: "application/json",
    });
    if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, `알림 설정 실패 (HTTP ${res.status})`);
  }

  // ---------- forward ----------
  /** ⚠ MUTATES server state: forward attachments to one room; form-urlencoded, empty body. */
  async forwardToRoom(roomSeq: number, cryptIds: unknown): Promise<{ ok: true; count: number }> {
    const uid = this.requireUser().id;
    const ids = normalizeForwardCryptIds(cryptIds);
    return this.forwardRequest(forwardRoomPath(roomSeq, ids, uid), ids.length);
  }

  /** ⚠ MUTATES server state: forward attachments to people (single|group); empty form-urlencoded body. */
  async forwardToMembers(
    memberSeqs: number[],
    cryptIds: unknown,
    roomType: "single" | "group"
  ): Promise<{ ok: true; count: number }> {
    const uid = this.requireUser().id;
    const ids = normalizeForwardCryptIds(cryptIds);
    return this.forwardRequest(forwardMembersPath(memberSeqs, ids, roomType, uid), ids.length);
  }

  private async forwardRequest(path: string, count: number): Promise<{ ok: true; count: number }> {
    const res = await this.request(path, { method: FORWARD_METHOD, contentType: "application/x-www-form-urlencoded" });
    if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, `전달 실패 (HTTP ${res.status})`);
    let body: any = null;
    try {
      body = JSON.parse(res.text);
    } catch {
      /* empty or non-JSON success body */
    }
    if (body?.code != null && String(body.code) !== "200") {
      const n = Number(body.code);
      const status = Number.isInteger(n) && n >= 100 && n <= 599 ? n : 500;
      throw new HttpError(status, String(body.message ?? body.msg ?? body.data?.message ?? `전달 실패 (code ${body.code})`));
    }
    return { ok: true, count };
  }

  // ---------- room notice ----------
  /** ⚠ MUTATES server state: PUT /api/chat/notice/{roomSeq}?messageId=…&userSeq=…, no body. */
  async registerRoomNotice(roomSeq: number, messageId: number): Promise<{ ok: true }> {
    const uid = this.requireUser().id;
    const res = await this.request(roomNoticePath(roomSeq, messageId, uid), { method: ROOM_NOTICE_METHOD });
    if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, `공지 등록 실패 (HTTP ${res.status})`);
    let body: any = null;
    try {
      body = JSON.parse(res.text);
    } catch {
      /* empty or non-JSON success body */
    }
    if (body?.code != null && String(body.code) !== "200") {
      const n = Number(body.code);
      const status = Number.isInteger(n) && n >= 100 && n <= 599 ? n : 500;
      throw new HttpError(status, String(body.message ?? body.msg ?? body.data?.message ?? `공지 등록 실패 (code ${body.code})`));
    }
    return { ok: true };
  }

  registerNotice(roomSeq: number, messageId: number): Promise<{ ok: true }> {
    return this.registerRoomNotice(roomSeq, messageId);
  }

  setRoomNotice(roomSeq: number, messageId: number): Promise<{ ok: true }> {
    return this.registerRoomNotice(roomSeq, messageId);
  }

  // ---------- chat backup ----------
  /** ⚠ MUTATES server state (creates a backup job): POST /api/chat/{roomSeq}/backup?userSeq=, JSON {fromDate,toDate,fileType}. */
  async requestBackup(roomSeq: number, from: string, to: string, fileType?: string): Promise<{ ok: true }> {
    const uid = this.requireUser().id;
    const path = backupRequestPath(roomSeq, uid);
    const res = await this.request(path, { method: "POST", json: buildBackupRequest(from, to, fileType) });
    this.checkBackupRes(res, "백업 요청 실패");
    return { ok: true };
  }

  async listBackups(): Promise<BackupItem[]> {
    const uid = this.requireUser().id;
    return parseBackupList(await this.getJson(backupListPath(uid)));
  }

  async downloadBackup(roomSeq: number, backupId: number): Promise<{ data: Buffer; contentType: string }> {
    const uid = this.requireUser().id;
    return this.fetchBinary(backupDownloadPath(roomSeq, backupId, uid));
  }

  /** ⚠ MUTATES server state: DELETE /api/chat/{roomSeq}/backup/{backupId}?userSeq= (also cancels an in-progress job). */
  async deleteBackup(roomSeq: number, backupId: number): Promise<{ ok: true }> {
    const uid = this.requireUser().id;
    const res = await this.request(backupDeletePath(roomSeq, backupId, uid), { method: "DELETE" });
    this.checkBackupRes(res, "백업 삭제 실패");
    return { ok: true };
  }

  /**
   * ⚠ DESTRUCTIVE + UNVERIFIED: PUT /api/chat/{roomSeq}/{messageId}/before?userSeq=, no body.
   * Callers must gate on HISTORY_CLEAR_ENABLED, user confirmation and the self-only guard (see main.ts).
   */
  async clearHistoryBefore(roomSeq: number, messageId: number): Promise<{ ok: true }> {
    const uid = this.requireUser().id;
    const res = await this.request(historyClearPath(roomSeq, messageId, uid), { method: HISTORY_CLEAR_METHOD });
    this.checkBackupRes(res, "대화 기록 삭제 실패");
    return { ok: true };
  }

  private checkBackupRes(res: Res, label: string): void {
    if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, `${label} (HTTP ${res.status})`);
    const err = backupBodyError(res.text);
    if (err) throw new HttpError(err.status, String(err.message ?? `${label} (code ${err.status})`));
  }

  // ---------- 공지톡 (pubsub circle) ----------
  async listPubsubs(page = 0): Promise<PubsubPage> {
    const uid = this.requireUser().id;
    return parsePubsubList(await this.getJson(pubsubListPath(page, uid)), page);
  }

  async getPubsub(id: number): Promise<PubsubDetail> {
    const uid = this.requireUser().id;
    const detail = parsePubsubDetail(await this.getJson(pubsubDetailPath(id, uid)));
    if (!detail) throw new Error("공지톡을 찾을 수 없습니다");
    return detail;
  }

  /**
   * ⚠ MUTATES server state, notifies every target: POST /api/chat/pubsubs/circle?userSeq=, JSON (UNVERIFIED shape).
   * Refuses unless UBM_PUBSUB_SEND=1; buildCircleBody refuses range "all". Callers must also run checkPubsubSend.
   */
  async sendPubsub(message: string, targets: unknown, range = "partial"): Promise<{ ok: true; count: number }> {
    if (!pubsubSendEnabled(process.env)) throw new Error(PUBSUB_SEND_DISABLED_TEXT);
    const uid = this.requireUser().id;
    const body = buildCircleBody({ message, targets, me: uid, range });
    const res = await this.request(pubsubSendPath(uid), { method: "POST", json: body });
    this.checkBackupRes(res, "공지톡 발송 실패");
    return { ok: true, count: body.nodes.length };
  }

  /** ⚠ MUTATES server state: DELETE /api/chat/pubsubs/circle/{id}?userSeq=. Gated like sendPubsub. */
  async deletePubsub(id: number): Promise<{ ok: true }> {
    if (!pubsubSendEnabled(process.env)) throw new Error(PUBSUB_SEND_DISABLED_TEXT);
    const uid = this.requireUser().id;
    const res = await this.request(pubsubDeletePath(id, uid), { method: "DELETE" });
    this.checkBackupRes(res, "공지톡 삭제 실패");
    return { ok: true };
  }

  // ---------- favorites ----------
  async listFavorites(): Promise<Person[]> {
    const uid = this.requireUser().id;
    return parseFavorites(await this.getJson(favoritePath(uid)));
  }
  getFavorites(): Promise<Person[]> {
    return this.listFavorites();
  }

  /** ⚠ MUTATES server state: POST /api/user/favorite?userSeq=<me> {"ids":[id]}. */
  async addFavorite(id: unknown): Promise<{ ok: true }> {
    return this.mutateFavorite("POST", id);
  }
  /** ⚠ MUTATES server state: DELETE /api/user/favorite?userSeq=<me> {"ids":[id]}. */
  async removeFavorite(id: unknown): Promise<{ ok: true }> {
    return this.mutateFavorite("DELETE", id);
  }

  private async mutateFavorite(method: "POST" | "DELETE", id: unknown): Promise<{ ok: true }> {
    const uid = this.requireUser().id;
    const body = JSON.stringify(favoriteBody(id));
    const res = await this.request(favoritePath(uid), {
      method,
      body: Buffer.from(body, "utf8"),
      contentType: "application/json",
    });
    if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, `즐겨찾기 ${method === "POST" ? "추가" : "삭제"} 실패 (HTTP ${res.status})`);
    return { ok: true };
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
    const body = await this.getJson(buildCreateGroupRoomPath(memberIds, uid), { method: "POST", json: {} });
    const roomSeq = Number(body?.data?.roomSeq);
    if (!Number.isFinite(roomSeq) || roomSeq <= 0) throw new Error("그룹 대화방을 만들지 못했습니다");
    return roomSeq;
  }

  // ---------- files ----------
  fileUrlPath(cryptId: string, messageId: number | undefined) {
    const uid = this.requireUser().id;
    return `/api/chat/files/${encodeURIComponent(cryptId)}?userSeq=${uid}${messageId ? `&messageId=${messageId}` : ""}`;
  }

  // ---------- Zoom ----------
  /** Read-only: GET /api/mobile/baseconfig → useZoomChat / zoomClientId. undefined when the server has no Zoom fields. */
  async fetchZoomConfig(): Promise<ZoomConfig | undefined> {
    this.requireUser();
    return parseZoomConfig(await this.getJson(ZOOM_CONFIG_PATH));
  }

  /**
   * Creates a Zoom meeting (Zoom-side only; nothing is sent to a room): POST /api/zoom/meetings, form accessToken=….
   * Returns "auth" when the token is rejected (caller must re-authorize). Gated by UBM_ZOOM=1.
   */
  async createZoomMeeting(accessToken: string): Promise<ZoomMeeting | "auth"> {
    if (!zoomEnabled(process.env)) throw new Error(ZOOM_DISABLED_TEXT);
    this.requireUser();
    const res = await this.request(ZOOM_MEETING_PATH, { method: ZOOM_MEETING_METHOD, form: zoomMeetingForm(accessToken) });
    if (isZoomAuthError(res.status, res.text)) return "auth";
    if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, `Zoom 회의 생성 실패 (HTTP ${res.status})`);
    const meeting = parseMeeting(res.text);
    if (!meeting) throw new HttpError(500, "Zoom 회의 링크를 받지 못했습니다");
    return meeting;
  }

  /** Authenticated GET of any same-server path (thumbnails, avatars, files). */
  async fetchBinary(path: string): Promise<{ data: Buffer; contentType: string }> {
    if (!path.startsWith("/")) path = "/" + path;
    // Chat files are bytes. The default Accept prefers JSON and some gateways honor it.
    const accept = path.startsWith("/api/chat/files/") ? "*/*" : undefined;
    const res = await this.request(path, accept ? { accept } : {});
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
    if (res.status === 401 && init.retry !== false) {
      const act = onSessionExpired({ webSession: this.webSession, hasCreds: !!this.creds, alreadyPrompted: this.authLostNotified });
      if (act === "native-relogin") {
        await this.refreshSession();
        return this.rawRequest(path, init);
      }
      if (act === "prompt-web") {
        this.authLostNotified = true;
        try { this.onAuthLost?.(); } catch { /* ignore */ }
      }
    }
    return res;
  }

  private async rawRequest(path: string, init: ReqInit): Promise<Res> {
    const url = this.baseUrl + path;
    const headers: Record<string, string> = {
      "User-Agent": "UBIONMessenger-Desktop/1.0",
      "X-Requested-With": "XMLHttpRequest",
      Accept: init.accept || "application/json, text/javascript, */*; q=0.01",
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
    }
    if (init.contentType) headers["Content-Type"] = init.contentType;
    const ctrl = new AbortController();
    const long = path.startsWith("/api/chat/files/");
    const timer = setTimeout(() => ctrl.abort(), (body && body.length > 1e6) || long ? 300_000 : 30_000);
    try {
      const res = await this.fetchImpl(url, {
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
  const attach: AttachModel | undefined = normalizeAttach(a, m.message ? String(m.message) : undefined, m.createdAt ? String(m.createdAt) : undefined);
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
    ...(isDeletedMessage(m) ? { deleted: true } : {}),
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
