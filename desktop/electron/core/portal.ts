import { MAIL_DELETE_ENABLED, deleteMail } from "./mail";
import { uploadMailAttachment, type Uploader, type UploadedAttach } from "./mail-attach";
import { sendMail, type MailSender, normalizeDraft } from "./mail-compose";
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
export type MailFolder = {
  id: string; name: string; fullName: string; encName: string; depth: number;
  newCnt: number; unseenCnt: number; totalCnt: number;
};
export type MailFolders = {
  quota: { usageUnit: string; limitUnit: string; percent: number };
  defaultFolders: MailFolder[];
  userFolders: MailFolder[];
  userSharedFolders: MailFolder[];
  userTags: string[];
};
import {
  isAllowedMailPost, mailListBody, normalizeMailListArgs, normalizeMailUid, parseMailList, parseMailMessage, validFolder,
  type MailListPage, type MailMessage,
} from "./mail";
export type { MailListPage, MailMessage, MailListItem, MailAttachment, MailAddr } from "./mail";

export const APPROVAL_BOXES = ["todo", "upcoming", "draft", "approve"] as const;
export type ApprovalBox = (typeof APPROVAL_BOXES)[number];
export const APPROVAL_BOX_LABELS: Record<ApprovalBox, string> = {
  todo: "결재 대기", upcoming: "결재 예정", draft: "기안 문서", approve: "결재한 문서",
};
export const APPROVAL_LIST_PATHS: Record<ApprovalBox, string> = {
  todo: "/api/approval/todo/all",
  upcoming: "/api/approval/upcoming",
  draft: "/api/approval/doclist/draft/all",
  approve: "/api/approval/doclist/approve/all",
};
export type ApprovalListItem = {
  id: number; documentId?: number; formName: string; title: string;
  docStatus?: string; docStatusName?: string; apprStatus?: string; apprStatusName?: string;
  attachCount: number; commentCount: number; drafterName: string; drafterDeptName: string; drafterPositionName: string;
  draftedAt?: string; emergency: boolean; currentActivityUsers: string[]; url: string;
};
export type ApprovalPage = { page: number; offset: number; total: number; totalPage: number; lastPage: boolean };
export type ApprovalList = { items: ApprovalListItem[]; page: ApprovalPage };
export type ApprovalAttachment = { id: string; name: string; extention: string; size: number; download?: string };
export type ApprovalActivity = {
  type: string; name: string; userName: string; userPosition: string; deptName: string;
  status: string; statusName: string; comment: string; completedAt?: string;
  userId?: number; thumbnail?: string;
};
export type ApprovalActivityGroup = { name: string; activities: ApprovalActivity[] };
export type ApprovalComment = { id: string; author: string; content: string; createdAt?: string };
export type ApprovalDocument = {
  id: number; formName: string; title: string; docStatusName: string; bodyHtml: string;
  attaches: ApprovalAttachment[]; drafterName: string; drafterDeptName: string; drafterPositionName: string; draftedAt?: string;
};
export type ApprovalDocumentDetail = {
  document: ApprovalDocument;
  apprFlow: { activityGroups: ApprovalActivityGroup[] };
  actionCheck: Record<string, boolean>;
  comments: ApprovalComment[];
};
/**
 * approval = todo count (/api/approval/todo/count docCount), noti = unread portal notis (/api/home/noti/count, same as web top bar),
 * mail = today's mail (/api/mail/message/count?today=on, same as web "오늘 온 메일"). Rail badge = approval + noti.
 */
export type PortalBadge = { approval: number; noti: number; mail: number };

export type CalendarEvent = {
  id: string; calendarId: number; calendarName: string; summary: string; location: string;
  allDay: boolean; start: string; end: string; type: string; url: string;
};
export type PortalWidgetId = "posts" | "approvalTodo" | "approvalUpcoming" | "noti" | "mail" | "calendar";
export type PortalWidgetData = {
  posts: PortalList<BoardPost>;
  approvalTodo: PortalList<ApprovalDoc>;
  approvalUpcoming: PortalList<ApprovalDoc>;
  noti: PortalList<PortalNoti>;
  /** today = "오늘 온 메일" count (web: /api/mail/message/count?today=on). NOT unread, NOT mailbox total. */
  mail: PortalList<MailItem> & { today?: number };
  calendar: PortalList<CalendarEvent>;
};
export type PortalWidgetState<K extends PortalWidgetId = PortalWidgetId> = {
  id: K; data?: PortalWidgetData[K]; error?: string; updatedAt?: number;
};

export type PortalEvents = {
  portalSummary: PortalSummary;
  portalWidget: PortalWidgetState;
  portalNewPost: { boardId: number; postId: number; boardName: string; summary: string; url: string };
  portalBadge: PortalBadge;
  /** More new posts than individual notifications (MAX_POST_NOTIFY); `atLeast` = the catch-up window was full. */
  portalNewPostSummary: { count: number; atLeast: boolean };
};

type Fetcher = (path: string, init?: { method?: string; json?: unknown }) => Promise<{ status: number; text: string }>;

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
  /^\/api\/userside\/baseconfig$/,
  /^\/api\/calendar\/user\/\d+\/calendar$/,
  /^\/api\/calendar\/event$/,
  /^\/api\/mail\/message\/gadget$/,
  /^\/api\/mail\/message\/count$/,
  /^\/api\/mail\/folder\/all$/,
  /^\/api\/approval\/(todo\/all|upcoming|doclist\/draft\/all|doclist\/approve\/all)$/,
  /^\/api\/approval\/(upcoming|todoreception|todoviewer)\/count$/,
  /^\/api\/approval\/document\/\d+$/,
  /^\/api\/approval\/document\/\d+\/comment$/,
];

/**
 * Native 결재/반려.
 * APPROVE — VERIFIED by Scott in Chrome DevTools (2026-10-23, doc 120738):
 *   PUT /api/approval/document/{docId}/approval  (application/json → 200)
 *   {"<docId>":{}, activityId, apprAction:"APPROVAL", apprFlowVersionId, arbtAddReferrer:false, comment, docVersionId, userApprSetting:{…}}
 * RETURN (반려) — ⚠ UNVERIFIED best guess: same path/body with apprAction:"RETURN" (DaouOffice term), comment required.
 * The doc 120728 detail response contains no action list and no "RETURN" string (enums seen: DRAFT, APPROVAL,
 * AGREEMENT, WAIT, COMPLETE, INPROGRESS…), so RETURN is still a guess. actionCheck.usePreviousReturn=true only
 * shows 반려-type features are enabled.
 */
export type ApprovalActionKind = "approve" | "return";
export const APPROVAL_ACTION_METHOD = "PUT";
export const APPROVAL_ACTION_PATH = (id: string) => `/api/approval/document/${id}/approval`;
export const APPROVAL_ACTION_WHITELIST: RegExp[] = [/^\/api\/approval\/document\/\d+\/approval$/];
export const APPR_ACTION: Record<ApprovalActionKind, string> = { approve: "APPROVAL", return: "RETURN" /* unverified */ };
export const APPROVAL_COMMENT_MAX = 1000;

export function normalizeApprovalActionArgs(kind: unknown, id: unknown, comment: unknown = "") {
  if (kind !== "approve" && kind !== "return") throw new Error("invalid approval action");
  const did = normalizeApprovalDocId(id);
  const c = typeof comment === "string" ? comment.trim() : "";
  if (c.length > APPROVAL_COMMENT_MAX) throw new Error(`의견은 ${APPROVAL_COMMENT_MAX}자 이내로 입력하세요`);
  if (kind === "return" && !c) throw new Error("반려 사유를 입력하세요");
  return { kind: kind as ApprovalActionKind, id: did, comment: c };
}

export type ApprovalActionContext = { activityId: number; apprFlowVersionId: number; docVersionId: number };

const posInt = (v: unknown): number | null => {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * Pull the three ids the approve PUT needs out of the raw GET /api/approval/document/{id} body.
 * Field paths PINNED from a real response (doc 120728, tests/fixtures/approval-doc-120728.sanitized.json):
 *   docVersionId      = data.document.docVersionId
 *   apprFlowVersionId = data.document.apprFlowVersionId
 *   activityId        = data.apprFlow.currentActivityId, which must be an activity in
 *                       data.apprFlow.activityGroups[].activities[] with status "WAIT" and userId === me.
 * Fails closed (throws a user-facing message, nothing is sent) on anything missing or inconsistent.
 */
export function extractApprovalActionContext(body: any, myUserId: number | null): ApprovalActionContext {
  const data = body?.data ?? {};
  const docVersionId = posInt(data?.document?.docVersionId);
  const apprFlowVersionId = posInt(data?.document?.apprFlowVersionId);
  const currentId = posInt(data?.apprFlow?.currentActivityId);
  const missing = [!currentId && "activityId", !apprFlowVersionId && "apprFlowVersionId", !docVersionId && "docVersionId"].filter(Boolean);
  if (missing.length) throw new Error(`결재 정보(${missing.join(", ")})를 문서에서 찾지 못해 처리하지 않았습니다. 웹에서 처리해 주세요.`);
  const acts = arr(data?.apprFlow?.activityGroups).flatMap((g: any) => arr(g?.activities));
  const cur = acts.find((a: any) => posInt(a?.id) === currentId);
  if (!cur || String(cur?.status) !== "WAIT")
    throw new Error("현재 결재 단계가 대기 상태가 아니어서 처리하지 않았습니다. 새로고침 후 다시 시도하세요.");
  if (myUserId == null || posInt(cur?.userId) !== myUserId)
    throw new Error("현재 결재 차례가 내 단계가 아니어서 처리하지 않았습니다. 웹에서 처리해 주세요.");
  return { activityId: currentId!, apprFlowVersionId: apprFlowVersionId!, docVersionId: docVersionId! };
}

/** Body exactly as observed from the web client, incl. the odd `"<docId>": {}` key. We never navigate → useNextApproval:false. */
export function approvalActionBody(docId: string, kind: ApprovalActionKind, ctx: ApprovalActionContext, comment: string) {
  return {
    [docId]: {},
    activityId: ctx.activityId,
    apprAction: APPR_ACTION[kind],
    apprFlowVersionId: ctx.apprFlowVersionId,
    arbtAddReferrer: false,
    comment,
    docVersionId: ctx.docVersionId,
    userApprSetting: { useNextApproval: false },
  };
}

/** DaouOffice wraps results as {code:"200", message, data}; a non-200 code in a 200 response is a failure. */
export function parseApprovalActionResult(status: number, text: string): { ok: true } {
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  const code = body?.code != null ? String(body.code) : String(status);
  if (status >= 200 && status < 300 && (code === "200" || code === String(status))) return { ok: true };
  const msg = typeof body?.message === "string" && body.message ? body.message : `HTTP ${status}`;
  const e = new Error(msg) as Error & { status?: number };
  e.status = status;
  throw e;
}

export function isApprovalBox(v: unknown): v is ApprovalBox {
  return typeof v === "string" && (APPROVAL_BOXES as readonly string[]).includes(v);
}

export function normalizeApprovalListArgs(box: unknown, page: unknown = 0, keyword: unknown = "") {
  if (!isApprovalBox(box)) throw new Error("invalid approval box");
  const p = Number(page);
  if (!Number.isInteger(p) || p < 0 || p > 10000) throw new Error("invalid page");
  const k = keyword == null ? "" : String(keyword);
  if (k.length > 100) throw new Error("keyword too long");
  return { box, page: p, keyword: k };
}

export function normalizeApprovalDocId(id: unknown): string {
  const s = typeof id === "number" ? String(id) : typeof id === "string" ? id.trim() : "";
  if (!/^\d+$/.test(s)) throw new Error("invalid document id");
  return s;
}

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

export function parseMailFolders(body: any): MailFolders {
  const data = body?.data ?? {};
  const folder = (f: any): MailFolder => ({
    id: str(f?.id), name: str(f?.name || f?.fullName || f?.encName),
    fullName: str(f?.fullName || f?.name), encName: str(f?.encName || f?.fullName || f?.name),
    depth: num(f?.depth), newCnt: num(f?.newCnt), unseenCnt: num(f?.unseenCnt), totalCnt: num(f?.totalCnt),
  });
  const q = data?.quotaInfo ?? {};
  return {
    quota: { usageUnit: str(q.usageUnit), limitUnit: str(q.limitUnit), percent: num(q.percent) },
    defaultFolders: arr(data?.defaultFolders).map(folder),
    userFolders: arr(data?.userFolders).map(folder),
    userSharedFolders: arr(data?.userSharedFolderList ?? data?.userSharedFolders).map(folder),
    userTags: arr(data?.userTags).map((t) => str(t?.name ?? t?.tagName ?? t)).filter(Boolean),
  };
}

function currentUsers(v: unknown): string[] {
  return arr(v).map((u) => str(u?.name ?? u?.userName ?? u?.deptName ?? u)).filter(Boolean);
}

export function parseApprovalList(body: any): ApprovalList {
  const items = arr(body?.data).map((d) => {
    const id = num(d?.id ?? d?.documentId);
    return {
      id, documentId: d?.documentId != null ? num(d.documentId) : undefined,
      formName: str(d?.formName), title: str(d?.title).slice(0, 300),
      docStatus: d?.docStatus ? str(d.docStatus) : undefined, docStatusName: d?.docStatusName ? str(d.docStatusName) : undefined,
      apprStatus: d?.apprStatus ? str(d.apprStatus) : undefined, apprStatusName: d?.apprStatusName ? str(d.apprStatusName) : undefined,
      attachCount: num(d?.attachCount), commentCount: num(d?.commentCount),
      drafterName: str(d?.drafterName), drafterDeptName: str(d?.drafterDeptName),
      drafterPositionName: str(d?.drafterPositionName), draftedAt: d?.draftedAt ? str(d.draftedAt) : undefined,
      emergency: !!d?.isEmergency, currentActivityUsers: currentUsers(d?.currentActivityUsers),
      url: `/app/approval/document/${id}`,
    };
  });
  const p = body?.page ?? {};
  const offset = num(p.offset, 20) || 20;
  const total = num(p.total, items.length);
  const totalPage = num(p.totalPage, total ? Math.ceil(total / offset) : 0);
  const page = num(p.page);
  return {
    items,
    page: { page, offset, total, totalPage, lastPage: p.lastPage != null ? !!p.lastPage : totalPage <= 0 || page + 1 >= totalPage },
  };
}

export function parseApprovalComments(body: any): ApprovalComment[] {
  return arr(body?.data ?? body).map((c, i) => {
    const createdAt = c?.createdAt ?? c?.createdDate ?? c?.regDate ?? c?.date ?? c?.completedAt;
    return {
      id: str(c?.id ?? c?.commentId ?? i),
      author: str(c?.userName ?? c?.name ?? c?.writerName ?? c?.user?.name ?? c?.writer?.name ?? c?.drafterName),
      content: str(c?.content ?? c?.comment ?? c?.body ?? c?.message ?? c?.text),
      createdAt: createdAt != null && createdAt !== "" ? str(createdAt) : undefined,
    };
  });
}

export function parseApprovalDoc(body: any, comments?: any): ApprovalDocumentDetail {
  const data = body?.data ?? {};
  const d = data?.document ?? {};
  const document: ApprovalDocument = {
    id: num(d?.id ?? d?.documentId),
    formName: str(d?.formName), title: str(d?.title), docStatusName: str(d?.docStatusName),
    bodyHtml: str(d?.docBodyContent),
    attaches: arr(d?.attaches).map((a) => ({
      id: str(a?.id), name: str(a?.name), extention: str(a?.extention ?? a?.extension),
      size: num(a?.size), download: a?.download != null ? str(a.download) : undefined,
    })),
    drafterName: str(d?.drafterName), drafterDeptName: str(d?.drafterDeptName),
    drafterPositionName: str(d?.drafterPosionName ?? d?.drafterPositionName),
    draftedAt: d?.draftedAt ? str(d.draftedAt) : undefined,
  };
  const groups = arr(data?.apprFlow?.activityGroups ?? data?.activityGroups).map((g) => ({
    name: str(g?.name),
    activities: arr(g?.activities).map((a) => ({
      type: str(a?.type), name: str(a?.name), userName: str(a?.userName), userPosition: str(a?.userPosition),
      deptName: str(a?.deptName), status: str(a?.status), statusName: str(a?.statusName), comment: str(a?.comment),
      completedAt: a?.completedAt ? str(a.completedAt) : undefined,
      userId: posInt(a?.userId ?? a?.actorId) ?? undefined,
      thumbnail: a?.thumbnail ? str(a.thumbnail) : undefined,
    })),
  }));
  const actionCheck: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(data?.actionCheck ?? {})) actionCheck[k] = !!v;
  return {
    document,
    apprFlow: { activityGroups: groups },
    actionCheck,
    comments: comments == null ? [] : parseApprovalComments(comments),
  };
}

/** Posts newer than lastMaxId (null = first observation → baseline, no notifications). */
export function detectNewPosts(posts: BoardPost[], lastMaxId: number | null): { fresh: BoardPost[]; maxId: number | null } {
  const ids = posts.map((p) => p.id).filter((n) => n > 0);
  if (!ids.length) return { fresh: [], maxId: lastMaxId };
  const maxId = Math.max(lastMaxId ?? 0, ...ids);
  if (lastMaxId == null) return { fresh: [], maxId };
  return { fresh: posts.filter((p) => p.id > lastMaxId).sort((a, b) => a.id - b.id), maxId };
}

// ---------------- calendar ('오늘 일정' card) ----------------
/**
 * The web calendar app (not the broken gadget endpoint /api/calendar/user/me/event/daily, which 500s) loads:
 *   GET /api/calendar/user/{userId}/calendar                     → my visible calendars (ids)
 *   GET /api/calendar/event?timeMin&timeMax&includingAttendees=true&calendarIds[]=…  → events
 * Note: for recurring holiday entries the server returns occurrences outside the range → filter client-side.
 */
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** Local-time ISO with offset, e.g. 2026-10-22T00:00:00.000+09:00 (what the web sends). */
export function isoLocal(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
export function dayBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return { start, end };
}
export function calendarIdsOf(body: any): number[] {
  return arr(body?.data).map((c) => num(c?.id)).filter((n) => n > 0);
}
export function eventsPath(ids: number[], now: Date): string {
  const { start, end } = dayBounds(now);
  const q = new URLSearchParams({ timeMin: isoLocal(start), timeMax: isoLocal(end), includingAttendees: "true" });
  for (const id of ids) q.append("calendarIds[]", String(id));
  return `/api/calendar/event?${q.toString()}`;
}
export function eventUrl(calendarId: number, id: string) {
  return `/app/calendar/${calendarId}/event/${encodeURIComponent(id)}`;
}
/** Parse /api/calendar/event and keep only events overlapping `now`'s local day; all-day first, then by start. */
export function parseTodayEvents(body: any, now: Date): PortalList<CalendarEvent> {
  const { start, end } = dayBounds(now);
  const items = arr(body?.data)
    .map((e) => {
      const allDay = str(e?.timeType) === "allday";
      const s0 = new Date(str(e?.startTime)), e0 = new Date(str(e?.endTime || e?.startTime));
      return { e, allDay, s0, e0 };
    })
    .filter(({ s0, e0, allDay }) => {
      if (Number.isNaN(s0.getTime())) return false;
      const endT = Number.isNaN(e0.getTime()) ? s0 : e0;
      // all-day end is inclusive date (start==end for one day)
      const endCmp = allDay ? new Date(endT.getFullYear(), endT.getMonth(), endT.getDate(), 23, 59, 59, 999) : endT;
      return s0 <= end && (allDay ? endCmp >= start : endCmp > start || s0 >= start);
    })
    .sort((a, b) => (a.allDay === b.allDay ? a.s0.getTime() - b.s0.getTime() : a.allDay ? -1 : 1))
    .map(({ e, allDay }) => {
      const calendarId = num(e.calendarId);
      const id = str(e.id);
      return {
        id, calendarId, calendarName: str(e.calendarName), summary: str(e.summary).slice(0, 200), location: str(e.location).slice(0, 120),
        allDay, start: str(e.startTime), end: str(e.endTime || e.startTime), type: str(e.type), url: eventUrl(calendarId, id),
      };
    });
  return { items, total: items.length };
}

// ---------------- menu ('메뉴' tab) ----------------
/**
 * One entry of the DaouOffice app menu. Source: GET /api/userside/baseconfig → data.menuConfigModel
 * (the same list the web GNB and the mobile app menu are built from, incl. admin-defined custom links).
 * - target "portal": `url` is a portal path ("/app/mail") → in-app SSO window.
 * - target "external": absolute URL on another host → OS browser.
 * - target "local": handled by the messenger itself (`local` = view name).
 */
export type MenuEntry = {
  id: string; name: string; appName: string; url: string; section?: string; custom: boolean;
  target: "portal" | "external" | "local"; local?: "home" | "chats" | "people";
};

const LOCAL_APPS: Record<string, MenuEntry["local"]> = { home: "home" };

/** Turn a menuConfigModel url into {target,url}. Same-host absolute URLs become portal paths. */
export function menuTarget(raw: string, appName: string, baseUrl: string): Pick<MenuEntry, "target" | "url"> | null {
  const u0 = str(raw).trim();
  const base = new URL(baseUrl);
  if (!u0) return appName && /^[a-z]+$/.test(appName) ? { target: "portal", url: `/app/${appName}` } : null;
  if (/^https?:\/\//i.test(u0)) {
    let u: URL;
    try { u = new URL(u0); } catch { return null; }
    if (u.username || u.password) return null;
    if (u.hostname === base.hostname) return { target: "portal", url: u.pathname + u.search + u.hash };
    return { target: "external", url: u.toString() };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(u0) || u0.startsWith("//")) return null; // javascript:, file:, protocol-relative …
  const path = "/" + u0.replace(/^\/+/, "");
  return path.includes("..") ? null : { target: "portal", url: path };
}

export function parseMenu(body: any, baseUrl: string): MenuEntry[] {
  const list = arr(body?.data?.menuConfigModel)
    .filter((m) => m && str(m.status || "online") === "online" && str(m.accessDeviceOption || "ALL").toUpperCase() !== "MOBILE")
    .sort((a, b) => num(a.seq) - num(b.seq));
  const out: MenuEntry[] = [];
  let section: string | undefined;
  for (const m of list) {
    const name = str(m.koName || m.name).trim();
    if (!name) continue;
    if (m.subMenuType) { section = name; continue; } // category header ("예약현황", "링크")
    if (num(m.depth) === 0) section = undefined;
    const appName = m.systemMenu ? str(m.appName) : "";
    const local = LOCAL_APPS[appName];
    const t = local ? { target: "local" as const, url: "" } : menuTarget(m.url, appName, baseUrl);
    if (!t) continue;
    out.push({ id: `m${num(m.id) || out.length}`, name, appName: appName || (t.target === "external" ? "link" : "custom"), url: t.url, section, custom: !m.systemMenu, target: t.target, local });
  }
  return out;
}

/** Fallback when baseconfig can't be read (offline server, API change). */
export const STATIC_MENU: MenuEntry[] = [
  ["mail", "메일"], ["calendar", "캘린더"], ["works", "Works"], ["board", "게시판"], ["approval", "전자결재"], ["report", "보고"],
  ["ehr", "근태"], ["survey", "설문"], ["community", "커뮤니티"], ["contact", "주소록"], ["webfolder", "클라우드"], ["todo", "ToDO"],
  ["asset", "회의실/스튜디오"],
].map(([appName, name]) => ({ id: `s-${appName}`, name, appName, url: `/app/${appName}`, custom: false, target: "portal" as const }));

/** Messenger-native entries the mobile menu has (Today/대화/조직도/알림), appended after the server list. */
export const LOCAL_MENU: MenuEntry[] = [
  { id: "l-today", name: "Today", appName: "home", url: "", custom: false, target: "local", local: "home", section: "메신저" },
  { id: "l-noti", name: "알림", appName: "noti", url: "", custom: false, target: "local", local: "home", section: "메신저" },
  { id: "l-chat", name: "대화", appName: "chat", url: "", custom: false, target: "local", local: "chats", section: "메신저" },
  { id: "l-org", name: "조직도", appName: "org", url: "", custom: false, target: "local", local: "people", section: "메신저" },
  { id: "l-flex", name: "flex (휴가·근무)", appName: "flex", url: "https://flex.team/home/todo/inbox", custom: true, target: "portal", section: "메신저" },
];

/** At most this many individual new-post notifications per check; the rest are summarised. */
export const MAX_POST_NOTIFY = 5;
/** How many posts to look at on the first check after start when a persisted baseline exists. */
export const CATCHUP_POSTS = 20;

/** Split fresh posts into individual notifications (newest MAX_POST_NOTIFY, oldest first) + a summary when more. */
export function planPostNotifications(fresh: BoardPost[], windowFull: boolean): { notify: BoardPost[]; summary: { count: number; atLeast: boolean } | null } {
  if (fresh.length <= MAX_POST_NOTIFY && !windowFull) return { notify: fresh, summary: null };
  const notify = fresh.slice(-MAX_POST_NOTIFY);
  return { notify, summary: fresh.length > MAX_POST_NOTIFY || windowFull ? { count: fresh.length, atLeast: windowFull } : null };
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
  /** Last-seen max post id persisted across runs (number only). null = first-ever run → silent baseline. */
  persistedMaxPostId: number | null = null;
  /** Current portal user id (for /api/calendar/user/{id}/calendar). */
  getUserId: () => number | null = () => null;
  /** Called whenever the max seen post id grows, so the host can persist it. */
  onPostBaseline: (id: number) => void = () => undefined;
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

  async mailFolders() { return parseMailFolders(await this.get("/api/mail/folder/all")); }

  /** JSON POST, restricted to MAIL_POST_WHITELIST (list/read only — never send/delete/move). */
  async post(path: string, json: unknown): Promise<any> {
    if (!isAllowedMailPost(path)) throw new Error(`portal POST not allowed: ${path.split("?")[0]}`);
    const res = await this.fetcher(path, { method: "POST", json });
    if (res.status !== 200) {
      const e = new Error(`HTTP ${res.status} ${path}`) as Error & { status?: number };
      e.status = res.status;
      throw e;
    }
    try {
      return JSON.parse(res.text);
    } catch {
      throw new Error(`invalid JSON ${path}`);
    }
  }

  /** ⚠ SENDS MAIL (verified request shape, see mail-compose.ts). Sender from the logged-in session. */
  getSender: () => Promise<MailSender | null> = async () => null;
  uploader: Uploader | null = null;
  /** Uploads one compose attachment (verified request, see mail-attach.ts). */
  async mailUpload(name: unknown, data: unknown, mime?: unknown): Promise<UploadedAttach> {
    if (!this.uploader) throw new Error("로그인이 필요합니다");
    const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
    if (!bytes) throw new Error("invalid attachment data");
    return uploadMailAttachment(this.uploader, { name: String(name ?? "file").split(/[\\/]/).pop() || "file", data: bytes, mime: typeof mime === "string" ? mime : undefined });
  }
  async mailSend(draft: unknown): Promise<{ ok: true }> {
    const d = normalizeDraft(draft);
    return sendMail(this.fetcher, d, await this.getSender());
  }

  mailCaps() { return { delete: MAIL_DELETE_ENABLED }; }
  /** ⚠ DELETES MAIL (verified request; moves to 휴지통, permanent from 휴지통). */
  async mailDelete(folder: unknown, uids: unknown): Promise<{ ok: true; count: number }> {
    return deleteMail(this.fetcher, folder, uids, MAIL_DELETE_ENABLED);
  }

  async mailList(folder: string, page = 1, keyword = ""): Promise<MailListPage> {
    const a = normalizeMailListArgs(folder, page, keyword);
    return parseMailList(await this.post("/api/mail/message/list", mailListBody(a)), a.folder);
  }

  /** ⚠ Marks the message as read on the server. Call only when the user opens a message. */
  async mailRead(folder: string, uid: number): Promise<MailMessage> {
    const f = validFolder(folder);
    return parseMailMessage(await this.post("/api/mail/message/read", { folder: f, uid: normalizeMailUid(uid) }), f);
  }

  async approvalList(box: ApprovalBox, page = 0, keyword = "") {
    const a = normalizeApprovalListArgs(box, page, keyword);
    const q = new URLSearchParams({
      page: String(a.page), offset: "20", direction: "desc", duration: "all",
      searchtype: a.keyword ? "title" : "", keyword: a.keyword,
    });
    return parseApprovalList(await this.get(`${APPROVAL_LIST_PATHS[a.box]}?${q.toString()}`));
  }

  async approvalCounts(): Promise<{ todo: number; upcoming: number }> {
    const [todo, upcoming] = await Promise.all([
      this.get("/api/approval/todo/count"),
      this.get("/api/approval/upcoming/count"),
    ]);
    return { todo: parseApprovalCount(todo), upcoming: parseApprovalCount(upcoming) };
  }

  /** ⚠ MUTATES server state (결재/반려). Only called from an explicit, confirmed user action. */
  /** ⚠ MUTATES server state (결재/반려). Only called from an explicit, confirmed user action. Re-reads the doc first (fresh versions). */
  async approvalAction(kind: unknown, id: unknown, comment: unknown = ""): Promise<{ ok: true }> {
    const a = normalizeApprovalActionArgs(kind, id, comment);
    const path = APPROVAL_ACTION_PATH(a.id);
    if (!APPROVAL_ACTION_WHITELIST.some((r) => r.test(path))) throw new Error("approval action path not allowed");
    const ctx = extractApprovalActionContext(await this.get(`/api/approval/document/${a.id}`), this.getUserId());
    this.log(`approval ${APPR_ACTION[a.kind]} doc=${a.id} activity=${ctx.activityId} comment=${a.comment ? `${a.comment.length}ch` : "none"}`);
    const res = await this.fetcher(path, { method: APPROVAL_ACTION_METHOD, json: approvalActionBody(a.id, a.kind, ctx, a.comment) });
    return parseApprovalActionResult(res.status, res.text);
  }

  async approvalDoc(id: number | string): Promise<ApprovalDocumentDetail> {
    const did = normalizeApprovalDocId(id);
    const [body, comments] = await Promise.all([
      this.get(`/api/approval/document/${did}`),
      this.get(`/api/approval/document/${did}/comment`).catch(() => null),
    ]);
    return parseApprovalDoc(body, comments);
  }

  private menuCache: { items: MenuEntry[]; source: "server" | "static"; at: number } | null = null;
  /** Server menu (cached 10 min), falling back to STATIC_MENU. Home ("홈") is dropped — the messenger has its own. */
  async menu(baseUrl: string, force = false): Promise<{ items: MenuEntry[]; source: "server" | "static" }> {
    if (!force && this.menuCache && Date.now() - this.menuCache.at < 10 * 60_000) return this.menuCache;
    let items: MenuEntry[] = [];
    let source: "server" | "static" = "server";
    try {
      items = parseMenu(await this.get("/api/userside/baseconfig"), baseUrl).filter((m) => m.local !== "home");
    } catch (e) {
      this.log(`portal menu failed: ${maskSecrets((e as Error).message)}`);
    }
    if (!items.length) { items = STATIC_MENU; source = "static"; }
    this.menuCache = { items: [...items, ...LOCAL_MENU], source, at: Date.now() };
    return this.menuCache;
  }

  async todayEvents(now = new Date()): Promise<PortalList<CalendarEvent>> {
    const uid = this.getUserId();
    if (!uid) throw new Error("no user");
    const ids = calendarIdsOf(await this.get(`/api/calendar/user/${uid}/calendar`));
    if (!ids.length) return { items: [], total: 0 };
    return parseTodayEvents(await this.get(eventsPath(ids, now)), now);
  }

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

  private checkPosts(list: PortalList<BoardPost>, catchUp: boolean) {
    const base = this.lastMaxPostId ?? this.persistedMaxPostId;
    const { fresh, maxId } = detectNewPosts(list.items, base);
    this.lastMaxPostId = maxId;
    // catch-up window "full" = every fetched post is new → there may be even more
    const windowFull = catchUp && list.items.length >= CATCHUP_POSTS && fresh.length >= list.items.length;
    const { notify, summary } = planPostNotifications(fresh, windowFull);
    for (const p of notify) this.emit("portalNewPost", { boardId: p.boardId, postId: p.id, boardName: p.boardName, summary: p.summary, url: p.url });
    if (summary) this.emit("portalNewPostSummary", summary);
    if (maxId != null && maxId !== this.persistedMaxPostId) {
      this.persistedMaxPostId = maxId;
      this.onPostBaseline(maxId);
    }
  }

  /** Light set: summary + badge counts + company posts (new-post detection). */
  async refreshLight(): Promise<boolean> {
    const mailToday = this.mailTodayCount().catch(() => undefined);
    const results = await Promise.allSettled([
      Promise.all([this.fetchSummary(), mailToday]).then(([s, t]) => { this.summary = withMailToday(s, t); this.emit("portalSummary", this.summary); }),
      this.approvalCount(),
      this.unreadNotiCount(),
      mailToday,
      (async () => {
        const catchUp = this.lastMaxPostId == null && this.persistedMaxPostId != null;
        const l = await this.companyPosts(catchUp ? CATCHUP_POSTS : 5);
        const shown = { ...l, items: l.items.slice(0, 5) };
        this.widgets.set("posts", { id: "posts", data: shown, updatedAt: Date.now() });
        this.emit("portalWidget", this.widgets.get("posts")!);
        this.checkPosts(l, catchUp);
      })(),
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
      this.widget("calendar", () => this.todayEvents()),
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
    this.menuCache = null;
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
