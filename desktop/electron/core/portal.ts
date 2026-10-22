/**
 * PortalService — read-only access to the DaouOffice portal home ("홈" tab).
 * - GET only, and only for whitelisted paths (see PORTAL_WHITELIST). Never POST/PUT/DELETE.
 * - Reuses DaouClient.request (GOSSOcookie session + its coalesced 401 refresh path).
 * - Data is kept in memory only (no disk cache). New-post detection keeps the max post id in memory.
 * - Never logs response bodies, cookies or credentials.
 */

export type PortalSummaryChip = { appName: string; gadgetName: string; count: number };
export type PortalSummary = { chips: PortalSummaryChip[] };
export type BoardPost = {
  id: number; boardId: number; boardName: string; type: string; summary: string; createdAt?: string;
  writerName: string; commentsCount: number; recommendCount: number; hasAttach: boolean; url: string;
};
export type ApprovalDoc = {
  id: number; documentId?: number; formName: string; title: string; docStatus?: string; apprStatus?: string;
  drafterName?: string; createdAt?: string; emergency?: boolean; url: string;
};
export type PortalNoti = {
  id: number; category: string; senderName: string; message: string; createdAt?: string; read?: boolean; url: string;
};
export type MailItem = {
  id: string; folderName: string; folderFullName: string; subject: string; from: string; dateUtc?: string;
  seen: boolean; priority?: string; url: string;
};
export type PortalList<T> = { items: T[]; total: number };
/**
 * approval = todo count (/api/approval/todo/count docCount), noti = unread portal notis (/api/home/noti/count, same as web top bar),
 * mail = today's mail (/api/mail/message/count?today=on, same as web "오늘 온 메일"). Rail badge = approval + noti.
 */
export type PortalBadge = { approval: number; noti: number; mail: number };

export type PortalWidgetId = "posts" | "approvalTodo" | "approvalUpcoming" | "noti" | "mail";
export type PortalWidgetData = {
  posts: PortalList<BoardPost>;
  approvalTodo: PortalList<ApprovalDoc>;
  approvalUpcoming: PortalList<ApprovalDoc>;
  noti: PortalList<PortalNoti>;
  /** today = "오늘 온 메일" count (web: /api/mail/message/count?today=on). NOT unread, NOT mailbox total. */
  mail: PortalList<MailItem> & { today?: number };
};
export type PortalWidgetState<K extends PortalWidgetId = PortalWidgetId> = {
  id: K; data?: PortalWidgetData[K]; error?: string; updatedAt?: number;
};

export type PortalEvents = {
  portalSummary: PortalSummary;
  portalWidget: PortalWidgetState;
  portalNewPost: { boardId: number; postId: number; boardName: string; summary: string; url: string };
  portalBadge: PortalBadge;
};

type Fetcher = (path: string, init?: { method?: string }) => Promise<{ status: number; text: string }>;

/** Path prefixes (pathname only) that may be requested. Exact match or regex. */
export const PORTAL_WHITELIST: RegExp[] = [
  /^\/api\/user\/today$/,
  /^\/api\/board\/posts\/company$/,
  /^\/api\/board\/\d+\/posts$/,
  /^\/api\/approval\/(todo|upcoming)$/,
  /^\/api\/approval\/todo\/count$/,
  /^\/api\/my\/noti$/,
  /^\/api\/my\/noti\/unread$/,
  /^\/api\/home\/noti\/count$/,
  /^\/api\/mail\/message\/gadget$/,
  /^\/api\/mail\/message\/count$/,
];

export function isAllowedPortalPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/.test(path)) return false;
  let pathname: string;
  try {
    const u = new URL(path, "https://x.invalid");
    if (u.host !== "x.invalid") return false;
    pathname = u.pathname;
  } catch {
    return false;
  }
  if (pathname.includes("..")) return false;
  return PORTAL_WHITELIST.some((r) => r.test(pathname));
}

/** Mask password/token/cookie-like values in any string before it reaches a log. */
export function maskSecrets(s: string): string {
  return String(s)
    .replace(/((?:password|passwd|pw|token|secret|cookie|GOSSOcookie|session|auth[a-z]*)["']?\s*[:=]\s*["']?)[^"'&;,\s}]+/gi, "$1***")
    .replace(/(Bearer\s+)[\w.\-~+/]+=*/gi, "$1***");
}

// ---------------- parsing (pure, unit-tested) ----------------
const num = (v: unknown, d = 0) => (v == null || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const str = (v: unknown) => (v == null ? "" : String(v));
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const total = (body: any, items: unknown[]) => num(body?.page?.total ?? body?.page?.totalElements ?? body?.pageInfo?.total, items.length);

export function postUrl(boardId: number, postId: number, type?: string) {
  if (!boardId) return "/app/board";
  if (!postId) return `/app/board/${boardId}`;
  return String(type || "").toUpperCase() === "STREAM" ? `/app/board/${boardId}/post/${postId}/stream` : `/app/board/${boardId}/post/${postId}`;
}

/**
 * Apps the web "투데이 프로필" gadget can show (its _connectedApp list, same order as the server).
 * Anything else in user/today summaries (e.g. appName "board" with empty gadgetName) is never shown on the web.
 */
export const SUMMARY_APPS = ["mail", "calendar", "community", "asset", "survey", "report", "task", "approval", "approval2"];
/** Web gadget labels (ko), used when the server omits gadgetName. */
export const SUMMARY_LABELS: Record<string, string> = {
  mail: "오늘 온 메일", community: "내 커뮤니티 새글", calendar: "오늘의 일정", asset: "내 예약/대여 현황", survey: "참여할 설문",
  report: "작성할 보고", task: "담당 업무", approval: "결재할 문서", approval2: "결재 수신 문서",
};

export function parseSummary(body: any): PortalSummary {
  const chips = arr(body?.data?.summaries)
    .filter((s) => SUMMARY_APPS.includes(str(s?.appName)))
    .map((s) => ({ appName: str(s.appName), gadgetName: str(s.gadgetName) || SUMMARY_LABELS[str(s.appName)], count: num(s.count) }));
  return { chips };
}

/** Web overrides the mail chip with /api/mail/message/count?today=on (user/today's own mail count is stale/0). */
export function withMailToday(s: PortalSummary, today: number | undefined): PortalSummary {
  if (today == null) return s;
  return { chips: s.chips.map((c) => (c.appName === "mail" ? { ...c, count: today } : c)) };
}

export function parsePosts(body: any): PortalList<BoardPost> {
  const items = arr(body?.data).map((p) => {
    const id = num(p.id), boardId = num(p.boardId);
    return {
      id, boardId, boardName: str(p.boardName), type: str(p.type),
      summary: str(p.summary || p.title).slice(0, 300), createdAt: p.createdAt ? str(p.createdAt) : undefined,
      writerName: str(p.writer?.name), commentsCount: num(p.commentsCount), recommendCount: num(p.recommendCount),
      hasAttach: !!p.hasAttach, url: postUrl(boardId, id, p.type),
    };
  });
  return { items, total: total(body, items) };
}

export function parseApprovals(body: any): PortalList<ApprovalDoc> {
  const items = arr(body?.data).map((d) => {
    const id = num(d.id ?? d.documentId);
    return {
      id, documentId: d.documentId != null ? num(d.documentId) : undefined,
      formName: str(d.formName), title: str(d.title).slice(0, 300),
      docStatus: d.docStatus ? str(d.docStatus) : undefined, apprStatus: d.apprStatus ? str(d.apprStatus) : undefined,
      drafterName: d.drafterName ? str(d.drafterName) : d.drafter?.name ? str(d.drafter.name) : undefined,
      createdAt: d.draftedAt || d.createdAt ? str(d.draftedAt || d.createdAt) : undefined,
      emergency: d.isEmergency != null ? !!d.isEmergency : d.emergency != null ? !!d.emergency : undefined,
      url: `/app/approval/document/${id}`,
    };
  });
  return { items, total: total(body, items) };
}

export function parseApprovalCount(body: any): number {
  const d = body?.data;
  if (typeof d === "number") return d;
  return num(d?.docCount ?? d?.count);
}

export function parseNotis(body: any): PortalList<PortalNoti> {
  const items = arr(body?.data).map((n) => {
    const id = num(n.id);
    const link = str(n.linkUrl);
    return {
      id, category: str(n.category), senderName: str(n.sender?.name ?? n.senderName ?? n.sender),
      message: str(n.message).replace(/<[^>]*>/g, "").slice(0, 300), createdAt: n.createdAt ? str(n.createdAt) : undefined,
      read: n.readAt != null ? true : n.read != null ? !!n.read : undefined,
      url: link.startsWith("/") && !link.startsWith("//") ? link : `/link/noti/${id}`,
    };
  });
  return { items, total: total(body, items) };
}

export function mailUrl(folderFullName: string, id: string) {
  return `/app/mail?work=read&folder=${encodeURIComponent(folderFullName)}&uid=${encodeURIComponent(id)}`;
}

export function parseMails(body: any): PortalList<MailItem> {
  const items = arr(body?.data?.messageList).map((m) => {
    const id = str(m.id), folderFullName = str(m.folderFullName || m.folderName || "Inbox");
    return {
      id, folderName: str(m.folderName), folderFullName, subject: str(m.subject).slice(0, 300),
      from: str(m.name || m.fromName || m.from), dateUtc: m.dateUtc != null ? str(m.dateUtc) : undefined,
      seen: !!m.seen, priority: m.priority != null ? str(m.priority) : undefined, url: mailUrl(folderFullName, id),
    };
  });
  return { items, total: num(body?.data?.pageInfo?.total ?? body?.data?.pageInfo?.totalElements, items.length) };
}

/** Plain `{data: <number>}` count responses (mail/message/count, home/noti/count). */
export function parseMailCount(body: any): number {
  const d = body?.data;
  if (typeof d === "number" || typeof d === "string") return num(d);
  return num(d?.unreadCount ?? d?.count ?? d?.unseen);
}

/** Posts newer than lastMaxId (null = first observation → baseline, no notifications). */
export function detectNewPosts(posts: BoardPost[], lastMaxId: number | null): { fresh: BoardPost[]; maxId: number | null } {
  const ids = posts.map((p) => p.id).filter((n) => n > 0);
  if (!ids.length) return { fresh: [], maxId: lastMaxId };
  const maxId = Math.max(lastMaxId ?? 0, ...ids);
  if (lastMaxId == null) return { fresh: [], maxId };
  return { fresh: posts.filter((p) => p.id > lastMaxId).sort((a, b) => a.id - b.id), maxId };
}

// ---------------- service ----------------
export const POLL_FOREGROUND_MS = 60_000;
export const POLL_BACKGROUND_MS = 4 * 60_000;
export const MAX_BACKOFF_MS = 10 * 60_000;

export function nextDelay(base: number, failures: number): number {
  if (failures <= 0) return base;
  return Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(failures, 6));
}

export class PortalService {
  private widgets = new Map<PortalWidgetId, PortalWidgetState>();
  private summary: PortalSummary | null = null;
  private badge: PortalBadge = { approval: 0, noti: 0, mail: 0 };
  private lastMaxPostId: number | null = null;
  private inflight = new Map<string, Promise<any>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private running = false;
  /** Home tab visible AND window focused → full set every 60s; otherwise light set every ~4 min. */
  homeActive = false;
  log: (msg: string) => void = () => undefined;

  constructor(private fetcher: Fetcher, private emit: <K extends keyof PortalEvents>(e: K, p: PortalEvents[K]) => void) {}

  /** Single entry point for network: whitelisted GET with in-flight dedupe. */
  async get(path: string): Promise<any> {
    if (!isAllowedPortalPath(path)) throw new Error(`portal path not allowed: ${path.split("?")[0]}`);
    const hit = this.inflight.get(path);
    if (hit) return hit;
    const p = (async () => {
      const res = await this.fetcher(path, { method: "GET" });
      if (res.status !== 200) {
        const e = new Error(`HTTP ${res.status} ${path.split("?")[0]}`) as Error & { status?: number };
        e.status = res.status;
        throw e;
      }
      try {
        return JSON.parse(res.text);
      } catch {
        throw new Error(`invalid JSON ${path.split("?")[0]}`);
      }
    })().finally(() => this.inflight.delete(path));
    this.inflight.set(path, p);
    return p;
  }

  // typed fetchers
  async fetchSummary() { return parseSummary(await this.get("/api/user/today")); }
  async companyPosts(n = 5) { return parsePosts(await this.get(`/api/board/posts/company?offset=${n}&page=0`)); }
  async approvals(type: "todo" | "upcoming", n = 5) { return parseApprovals(await this.get(`/api/approval/${type}?page=0&offset=${n}`)); }
  async approvalCount() { return parseApprovalCount(await this.get("/api/approval/todo/count")); }
  async notis(n = 10) { return parseNotis(await this.get(`/api/my/noti?page=0&offset=${n}`)); }
  /** Web top-bar unread noti count. (/api/my/noti/unread page.total is always 0 — do not use.) */
  async unreadNotiCount() { return parseMailCount(await this.get("/api/home/noti/count")); }
  async mails(n = 5) { return parseMails(await this.get(`/api/mail/message/gadget?count=${n}`)); }
  /** "오늘 온 메일" — web POSTs {today:on}; the GET query form returns the same number. Without it = mailbox total. */
  async mailTodayCount() { return parseMailCount(await this.get("/api/mail/message/count?today=on")); }

  snapshot() {
    return { summary: this.summary, badge: this.badge, widgets: Object.fromEntries(this.widgets) as Partial<Record<PortalWidgetId, PortalWidgetState>> };
  }
  getWidget(id: PortalWidgetId) { return this.widgets.get(id) ?? { id }; }

  private async widget<K extends PortalWidgetId>(id: K, fn: () => Promise<PortalWidgetData[K]>): Promise<boolean> {
    try {
      const data = await fn();
      const st: PortalWidgetState = { id, data, updatedAt: Date.now() };
      this.widgets.set(id, st);
      this.emit("portalWidget", st);
      return true;
    } catch (e) {
      const prev = this.widgets.get(id);
      const st: PortalWidgetState = { ...prev, id, error: maskSecrets((e as Error).message) };
      this.widgets.set(id, st);
      this.emit("portalWidget", st);
      this.log(`portal widget ${id} failed: ${st.error}`);
      return false;
    }
  }

  private checkPosts(list: PortalList<BoardPost>) {
    const { fresh, maxId } = detectNewPosts(list.items, this.lastMaxPostId);
    this.lastMaxPostId = maxId;
    for (const p of fresh) this.emit("portalNewPost", { boardId: p.boardId, postId: p.id, boardName: p.boardName, summary: p.summary, url: p.url });
  }

  /** Light set: summary + badge counts + company posts (new-post detection). */
  async refreshLight(): Promise<boolean> {
    const mailToday = this.mailTodayCount().catch(() => undefined);
    const results = await Promise.allSettled([
      Promise.all([this.fetchSummary(), mailToday]).then(([s, t]) => { this.summary = withMailToday(s, t); this.emit("portalSummary", this.summary); }),
      this.approvalCount(),
      this.unreadNotiCount(),
      mailToday,
      this.companyPosts(5).then((l) => {
        this.widgets.set("posts", { id: "posts", data: l, updatedAt: Date.now() });
        this.emit("portalWidget", this.widgets.get("posts")!);
        this.checkPosts(l);
      }),
    ]);
    const [, a, n, m] = results;
    const mailChip = this.summary?.chips.find((c) => c.appName === "mail");
    const mailNow = m.status === "fulfilled" && m.value != null ? (m.value as number) : mailChip?.count;
    const next: PortalBadge = {
      approval: a.status === "fulfilled" ? (a.value as number) : this.badge.approval,
      noti: n.status === "fulfilled" ? (n.value as number) : this.badge.noti,
      mail: mailNow ?? this.badge.mail,
    };
    this.setBadge(next);
    return results.every((r) => r.status === "fulfilled");
  }


  /** Full set (Home visible): light + all MVP widgets. */
  async refreshAll(): Promise<boolean> {
    const okLight = await this.refreshLight();
    const oks = await Promise.all([
      this.widget("approvalTodo", () => this.approvals("todo", 5)),
      this.widget("approvalUpcoming", () => this.approvals("upcoming", 5)),
      this.widget("noti", () => this.notis(10)),
      this.widget("mail", async () => ({ ...(await this.mails(5)), today: this.badge.mail })),
    ]);
    return okLight && oks.every(Boolean);
  }

  private setBadge(b: PortalBadge) {
    if (b.approval === this.badge.approval && b.noti === this.badge.noti && b.mail === this.badge.mail) return;
    this.badge = b;
    this.emit("portalBadge", b);
  }

  start() {
    this.running = true;
    this.schedule(0);
  }
  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  reset() {
    this.stop();
    this.widgets.clear();
    this.summary = null;
    this.badge = { approval: 0, noti: 0, mail: 0 };
    this.lastMaxPostId = null;
  }
  /** Called on Home visibility/focus changes and manual refresh: refresh now, then reschedule. */
  setHomeActive(active: boolean) {
    const was = this.homeActive;
    this.homeActive = active;
    if (this.running && active && !was) this.schedule(0);
  }
  async refreshNow() {
    const ok = await this.refreshAll();
    this.failures = ok ? 0 : this.failures;
    if (this.running) this.schedule(this.homeActive ? POLL_FOREGROUND_MS : POLL_BACKGROUND_MS);
    return this.snapshot();
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }
  private async tick() {
    if (!this.running) return;
    let ok = false;
    try {
      ok = this.homeActive ? await this.refreshAll() : await this.refreshLight();
    } catch {
      ok = false;
    }
    this.failures = ok ? 0 : this.failures + 1;
    if (this.running) this.schedule(nextDelay(this.homeActive ? POLL_FOREGROUND_MS : POLL_BACKGROUND_MS, this.failures));
  }
}
