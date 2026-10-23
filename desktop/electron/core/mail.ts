/**
 * Native mail (v1.0.11): list + read via the same JSON endpoints the DaouOffice web mail uses.
 * Live-verified on coco.ubion.co.kr (2026-10-23):
 *  - POST /api/mail/message/list  JSON {folder, page(1-based), offset(page size), keyWord?}
 *      → data{folderName, folderFullName, total, unreadMessageCount, pageInfo{page,pageSize,total,lastPage}, messageList[]}
 *      messageList[]: {id, folderName, folderFullName, subject, from ("Name"<addr>), preview, dateUtc, seen, flag, priority, size, byteSize}
 *      flag letters: S=seen, T=attachment, A=answered, F=flagged (others ignored). messageList is absent when empty.
 *      ⚠ page MUST be ≥1 together with offset — without them the server returns the whole folder.
 *  - POST /api/mail/message/read  JSON {folder, uid} → data.msgContent{uid, subject, from, fromPersonal, dateUtc,
 *      htmlContent, priority, flaged, toList[{personal,address}], ccList?, attachList[{path,fileName,size,fileType,fsize}]}
 *      ⚠ marks the message as read on the server (normal mail behaviour; only on explicit user selection).
 * MAIL_POST_WHITELIST covers list/read only; send (mail-compose.ts) and delete (deleteMail) are separate, dedicated calls.
 */
export type MailAddr = { name: string; address: string };
export type MailListItem = {
  uid: number; folder: string; subject: string; from: MailAddr; preview: string; dateUtc?: string;
  seen: boolean; hasAttach: boolean; flagged: boolean; answered: boolean; important: boolean; size: string;
};
export type MailListPage = {
  folder: string; folderName: string; items: MailListItem[]; page: number; pageSize: number; total: number;
  unread: number; lastPage: boolean; search: boolean;
};
export type MailAttachment = { part: string; name: string; size: number; sizeLabel: string; type: string };
export type MailMessage = {
  uid: number; folder: string; subject: string; from: MailAddr; to: MailAddr[]; cc: MailAddr[]; dateUtc?: string;
  html: string; important: boolean; flagged: boolean; attachments: MailAttachment[];
};

export const MAIL_PAGE_SIZE = 30;
export const MAIL_POST_WHITELIST: RegExp[] = [/^\/api\/mail\/message\/list$/, /^\/api\/mail\/message\/read$/];

const num = (v: unknown, d = 0) => (v == null || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const str = (v: unknown) => (v == null ? "" : String(v));
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

export function isAllowedMailPost(path: string): boolean {
  return MAIL_POST_WHITELIST.some((r) => r.test(path));
}

/** `"홍길동"<hong@x.com>`, `홍길동 <a@b>`, `a@b` → {name, address}. */
export function parseAddr(raw: unknown, personal?: unknown): MailAddr {
  const s = str(raw).trim();
  const m = /^\s*"*([^"<]*?)"*\s*<([^>]*)>?\s*$/.exec(s);
  let name = "", address = s;
  if (m) { name = m[1].trim(); address = m[2].trim(); }
  const p = str(personal).trim();
  if (p) name = p;
  return { name: name || address, address };
}

export function validFolder(f: unknown): string {
  const s = str(f);
  if (!s || s.length > 300 || /[\r\n\0]/.test(s)) throw new Error("invalid folder");
  return s;
}

export function normalizeMailListArgs(folder: unknown, page: unknown = 1, keyword: unknown = "") {
  const p = Number(page);
  if (!Number.isInteger(p) || p < 1 || p > 100000) throw new Error("invalid page");
  const k = keyword == null ? "" : String(keyword).trim();
  if (k.length > 100) throw new Error("keyword too long");
  return { folder: validFolder(folder), page: p, keyword: k };
}

export function mailListBody(a: { folder: string; page: number; keyword: string }, pageSize = MAIL_PAGE_SIZE) {
  const b: Record<string, unknown> = { folder: a.folder, page: a.page, offset: pageSize };
  if (a.keyword) b.keyWord = a.keyword;
  return b;
}

export function normalizeMailUid(uid: unknown): number {
  const n = Number(uid);
  if (!Number.isInteger(n) || n <= 0) throw new Error("invalid uid");
  return n;
}

export const isImportant = (priority: unknown) => /^(high|highest|urgent|1|2)$/i.test(str(priority).trim());

export function parseMailList(body: any, folder: string): MailListPage {
  const d = body?.data ?? {};
  const pi = d.pageInfo ?? {};
  const items: MailListItem[] = arr(d.messageList).map((m) => {
    const flag = str(m.flag).toUpperCase();
    return {
      uid: num(m.id), folder: str(m.folderFullName || folder), subject: str(m.subject).slice(0, 500),
      from: parseAddr(m.from), preview: str(m.preview).replace(/\s+/g, " ").trim().slice(0, 300),
      dateUtc: m.dateUtc ? str(m.dateUtc) : undefined, seen: m.seen != null ? !!m.seen : flag.includes("S"),
      hasAttach: flag.includes("T"), flagged: flag.includes("F"), answered: flag.includes("A"),
      important: isImportant(m.priority), size: str(m.size),
    };
  }).filter((m) => m.uid > 0);
  const total = num(pi.total ?? d.total, items.length);
  const page = num(pi.page ?? d.currentPage, 1);
  const pageSize = num(pi.pageSize, MAIL_PAGE_SIZE);
  return {
    folder: str(d.folderFullName || folder), folderName: str(d.folderName), items, page, pageSize, total,
    unread: num(d.unreadMessageCount), search: !!d.search,
    lastPage: pi.lastPage != null ? !!pi.lastPage || page * pageSize >= total : page * pageSize >= total,
  };
}

export function parseMailMessage(body: any, folder: string): MailMessage {
  const c = body?.data?.msgContent ?? {};
  const addrs = (l: unknown) => arr(l).map((a) => parseAddr(a?.address ?? a, a?.personal));
  return {
    uid: num(c.uid), folder: str(c.folderFullName || folder), subject: str(c.subject),
    from: parseAddr(c.from, c.fromPersonal), to: addrs(c.toList), cc: addrs(c.ccList),
    dateUtc: c.dateUtc ? str(c.dateUtc) : undefined, html: str(c.htmlContent),
    important: isImportant(c.priority), flagged: !!c.flaged,
    attachments: arr(c.attachList).map((a) => ({
      part: str(a.path), name: str(a.fileName) || "첨부파일", size: num(a.size), sizeLabel: str(a.fsize), type: str(a.fileType),
    })),
  };
}

/** Summary shown in the reading pane when nothing is selected. Derived from data already loaded. */
export function mailOverview(page: MailListPage | null, inboxUnread: number) {
  const items = page?.items ?? [];
  const senders = new Map<string, { name: string; address: string; count: number; unread: number }>();
  for (const m of items) {
    const k = m.from.address || m.from.name;
    const s = senders.get(k) ?? { ...m.from, count: 0, unread: 0 };
    s.count++;
    if (!m.seen) s.unread++;
    senders.set(k, s);
  }
  return {
    unread: inboxUnread,
    unreadOnPage: items.filter((m) => !m.seen).length,
    important: items.filter((m) => m.important || m.flagged).length,
    withAttach: items.filter((m) => m.hasAttach).length,
    recentSenders: [...senders.values()].sort((a, b) => b.count - a.count).slice(0, 6),
    importantItems: items.filter((m) => m.important || m.flagged).slice(0, 5),
  };
}

// ---------------- delete (v1.0.14) ----------------
/**
 * The ONE mail delete request — VERIFIED from Scott's capture (2026-10-23):
 *   POST /api/mail/message/delete, JSON {"folderNames":["Inbox"],"uids":["67572"]} → 200 JSON.
 * Web moves to 휴지통; the same call from 휴지통 is assumed to delete permanently.
 */
export const MAIL_DELETE_METHOD = "POST";
export const MAIL_DELETE_PATH = "/api/mail/message/delete";
export const MAIL_DELETE_MAX = 200;
/** Kill switch (request verified). */
export const MAIL_DELETE_ENABLED = true;

export const isTrashFolder = (folder: string, name = "") => /^trash$/i.test(folder) || /^(휴지통|지운\s*편지함)$/.test(name.trim());

export function normalizeMailDeleteArgs(folder: unknown, uids: unknown): { folder: string; uids: number[] } {
  const f = validFolder(folder);
  if (!Array.isArray(uids) || !uids.length) throw new Error("삭제할 메일을 선택하세요");
  if (uids.length > MAIL_DELETE_MAX) throw new Error(`한 번에 ${MAIL_DELETE_MAX}통까지 삭제할 수 있습니다`);
  return { folder: f, uids: [...new Set(uids.map((u) => normalizeMailUid(u)))] };
}

/** Body VERIFIED from capture (web delete of one Inbox mail): {"folderNames":["Inbox"],"uids":["67572"]} — parallel arrays, uids as strings. */
export function mailDeleteBody(a: { folder: string; uids: number[] }) {
  return { folderNames: a.uids.map(() => a.folder), uids: a.uids.map(String) };
}

type DelFetcher = (path: string, init?: { method?: string; json?: unknown }) => Promise<{ status: number; text: string }>;
export async function deleteMail(fetcher: DelFetcher, folder: unknown, uids: unknown, enabled: boolean): Promise<{ ok: true; count: number }> {
  if (!enabled) throw new Error("메일 삭제는 서버 API 확인 전이라 아직 꺼져 있습니다");
  const a = normalizeMailDeleteArgs(folder, uids);
  const res = await fetcher(MAIL_DELETE_PATH, { method: MAIL_DELETE_METHOD, json: mailDeleteBody(a) });
  let body: any = null;
  try { body = res.text ? JSON.parse(res.text) : null; } catch { /* ignore */ }
  if (res.status === 200 && (body?.code == null || String(body.code) === "200")) return { ok: true, count: a.uids.length };
  const m = body?.message;
  throw new Error(typeof m === "string" && m ? m : `메일 삭제 실패 (HTTP ${res.status}${body?.code != null ? `, code ${body.code}` : ""})`);
}

/** Pure list update for optimistic delete: remaining items, next selection, unread decrement. */
export function applyMailDelete<T extends { uid: number; folder: string; seen: boolean }>(items: T[], folder: string, uids: number[], selUid?: number | null) {
  const del = new Set(uids);
  const remaining = items.filter((m) => !(m.folder === folder && del.has(m.uid)));
  const unreadRemoved = items.filter((m) => m.folder === folder && del.has(m.uid) && !m.seen).length;
  let next: T | null = null;
  if (selUid != null && del.has(selUid)) {
    const idx = items.findIndex((m) => m.uid === selUid && m.folder === folder);
    next = items.slice(idx + 1).find((m) => !del.has(m.uid) || m.folder !== folder) ?? [...items.slice(0, idx)].reverse().find((m) => !del.has(m.uid) || m.folder !== folder) ?? null;
  }
  return { remaining, unreadRemoved, next };
}
