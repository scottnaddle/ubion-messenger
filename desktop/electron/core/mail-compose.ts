/**
 * Native mail compose (v1.0.13). Pure helpers (renderer + main) + the single UNVERIFIED send block.
 *
 * ⚠ SEND IS UNVERIFIED AND DISABLED (MAIL_SEND_ENABLED = false).
 * No capture of the DaouOffice web "보내기" request exists yet. The web mail JS is only served to logged-in
 * sessions, the public OpenAPI (api.daouoffice.com) has no user-mail send, and the repo only names
 * /api/mail/message/send in negative whitelist tests. The candidate below mirrors the verified
 * POST /api/mail/message/{list,read} JSON family — method, path AND body are guesses.
 * Until Scott captures one real send, the UI offers "웹에서 이어 쓰기" instead of sending.
 */
import { sanitizeHtmlToText } from "./mail-text";
import type { MailAddr, MailMessage } from "./mail";

export const MAIL_SEND_ENABLED = false;
export const MAIL_SEND_METHOD = "POST"; // UNVERIFIED
export const MAIL_SEND_PATH = "/api/mail/message/send"; // UNVERIFIED
export const MAIL_SEND_WHITELIST: RegExp[] = [/^\/api\/mail\/message\/send$/];

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";
export type ComposeAttachment = { name: string; size: number; path?: string };
export type MailDraft = {
  mode: ComposeMode; to: MailAddr[]; cc: MailAddr[]; bcc: MailAddr[]; subject: string; html: string;
  attachments: ComposeAttachment[]; ref?: { folder: string; uid: number };
};

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
export const isEmail = (s: string) => EMAIL.test(s.trim());

/** "홍길동 <a@b.com>, c@d.com; 김 <e@f>" → addrs (invalid tokens returned separately). */
export function parseRecipients(text: string): { addrs: MailAddr[]; invalid: string[] } {
  const addrs: MailAddr[] = [], invalid: string[] = [];
  for (const raw of text.split(/[,;\n]/)) {
    const t = raw.trim();
    if (!t) continue;
    const m = /^"?([^"<]*?)"?\s*<([^>]+)>$/.exec(t);
    const address = (m ? m[2] : t).trim(), name = (m ? m[1] : "").trim();
    if (isEmail(address)) addrs.push({ name: name || address, address });
    else invalid.push(t);
  }
  return { addrs, invalid };
}

export function dedupeAddrs(list: MailAddr[], exclude: string[] = []): MailAddr[] {
  const seen = new Set(exclude.map((e) => e.toLowerCase()));
  const out: MailAddr[] = [];
  for (const a of list) {
    const k = a.address.toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmtAddrs = (l: MailAddr[]) => l.map((a) => (a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address)).join(", ");
export const prefixSubject = (p: "RE" | "FW", s: string) => (new RegExp(`^\\s*${p}\\s*:`, "i").test(s) ? s : `${p}: ${s}`);

/** Build a reply / reply-all / forward draft. `quotedHtml` must already be sanitized by the caller. */
export function buildDraft(mode: ComposeMode, msg: MailMessage | null, myEmail: string, quotedHtml = "", date = ""): MailDraft {
  const base: MailDraft = { mode, to: [], cc: [], bcc: [], subject: "", html: "", attachments: [] };
  if (mode === "new" || !msg) return { ...base, mode: "new" };
  const header = [
    "-----Original Message-----",
    `From: ${fmtAddrs([msg.from])}`,
    `To: ${fmtAddrs(msg.to)}`,
    msg.cc.length ? `Cc: ${fmtAddrs(msg.cc)}` : "",
    date ? `Sent: ${date}` : "",
    `Subject: ${msg.subject}`,
  ].filter(Boolean).map(esc).join("<br>");
  const html = `<p><br></p><p><br></p><blockquote class="mail-quote">${header}<br><br>${quotedHtml}</blockquote>`;
  const ref = { folder: msg.folder, uid: msg.uid };
  if (mode === "forward") return { ...base, subject: prefixSubject("FW", msg.subject), html, ref };
  const me = myEmail ? [myEmail] : [];
  const to = dedupeAddrs([msg.from], mode === "reply" ? [] : me);
  const cc = mode === "replyAll" ? dedupeAddrs([...msg.to, ...msg.cc], [...me, ...to.map((a) => a.address)]) : [];
  return { ...base, to: to.length ? to : [msg.from], cc, subject: prefixSubject("RE", msg.subject), html, ref };
}

export const MAIL_SUBJECT_MAX = 500;
export const MAIL_RECIPIENTS_MAX = 200;
export const MAIL_BODY_MAX = 2_000_000;

export function validateDraft(d: MailDraft): string | null {
  const all = [...d.to, ...d.cc, ...d.bcc];
  if (!d.to.length) return "받는 사람을 입력하세요";
  if (all.length > MAIL_RECIPIENTS_MAX) return `수신자는 ${MAIL_RECIPIENTS_MAX}명 이하로 지정하세요`;
  const bad = all.find((a) => !isEmail(a.address));
  if (bad) return `잘못된 주소: ${bad.address}`;
  if (d.subject.length > MAIL_SUBJECT_MAX) return "제목이 너무 깁니다";
  if (d.html.length > MAIL_BODY_MAX) return "본문이 너무 깁니다";
  return null;
}

export const isDraftDirty = (d: MailDraft, initial: MailDraft) =>
  JSON.stringify({ ...d, html: d.html.trim() }) !== JSON.stringify({ ...initial, html: initial.html.trim() });

/** UNVERIFIED body shape — fix here once the real request is captured. Attachments not supported yet. */
export function mailSendBody(d: MailDraft) {
  return {
    to: fmtAddrs(d.to), cc: fmtAddrs(d.cc), bcc: fmtAddrs(d.bcc),
    subject: d.subject, content: d.html, contentType: "html",
    sendType: d.mode === "new" ? "normal" : d.mode, // UNVERIFIED
    ...(d.ref ? { folder: d.ref.folder, uid: d.ref.uid } : {}),
  };
}

/** Plain-text version used for the "웹에서 이어 쓰기" clipboard fallback. */
export function draftAsText(d: MailDraft): string {
  return [
    `받는 사람: ${fmtAddrs(d.to)}`, d.cc.length ? `참조: ${fmtAddrs(d.cc)}` : "", d.bcc.length ? `숨은참조: ${fmtAddrs(d.bcc)}` : "",
    `제목: ${d.subject}`, "", sanitizeHtmlToText(d.html),
  ].filter((l, i) => l !== "" || i === 4).join("\n");
}

/** IPC boundary: coerce an untrusted renderer object into a MailDraft (throws on garbage). */
export function normalizeDraft(v: unknown): MailDraft {
  const o = (v ?? {}) as any;
  const addrs = (l: unknown): MailAddr[] => (Array.isArray(l) ? l : []).map((a: any) => ({ name: String(a?.name ?? ""), address: String(a?.address ?? "").trim() }));
  const modes: ComposeMode[] = ["new", "reply", "replyAll", "forward"];
  if (!modes.includes(o.mode)) throw new Error("invalid compose mode");
  return {
    mode: o.mode, to: addrs(o.to), cc: addrs(o.cc), bcc: addrs(o.bcc), subject: String(o.subject ?? ""), html: String(o.html ?? ""),
    attachments: (Array.isArray(o.attachments) ? o.attachments : []).map((a: any) => ({ name: String(a?.name ?? ""), size: Number(a?.size) || 0 })),
    ref: o.ref && Number.isInteger(o.ref.uid) ? { folder: String(o.ref.folder), uid: o.ref.uid } : undefined,
  };
}

type Fetcher = (path: string, init?: { method?: string; json?: unknown }) => Promise<{ status: number; text: string }>;

/** The ONE place that would send mail. Refuses unless explicitly enabled (never from the renderer). */
export async function sendMail(fetcher: Fetcher, d: MailDraft, enabled = MAIL_SEND_ENABLED): Promise<{ ok: true }> {
  if (!enabled) throw new Error("앱 내 메일 발송은 아직 검증되지 않아 꺼져 있습니다. '웹에서 이어 쓰기'를 사용하세요.");
  const err = validateDraft(d);
  if (err) throw new Error(err);
  if (d.attachments.length) throw new Error("첨부파일 발송은 아직 지원하지 않습니다");
  if (!MAIL_SEND_WHITELIST.some((r) => r.test(MAIL_SEND_PATH))) throw new Error("mail send path not allowed");
  const res = await fetcher(MAIL_SEND_PATH, { method: MAIL_SEND_METHOD, json: mailSendBody(d) });
  let body: any = null;
  try { body = res.text ? JSON.parse(res.text) : null; } catch { /* ignore */ }
  if (res.status === 200 && (body?.code == null || String(body.code) === "200")) return { ok: true };
  throw new Error(typeof body?.message === "string" && body.message ? body.message : `HTTP ${res.status}`);
}
