/**
 * 공지톡 (bulk notice / "circle" pubsub) — pure path/parse/guard helpers (no Electron, safe to import from the renderer).
 *
 * Original 3.5.42 renderer:
 *   send    POST   /api/chat/pubsubs/circle?userSeq=            JSON (gu(e), see buildCircleBody)
 *   list    GET    /api/chat/pubsubs/circle?size=10&userSeq=&page=   → {data:[…], page:{total}}
 *   detail  GET    /api/chat/pubsubs/circle/{messageId}?userSeq=     → {data:{…, accessTarget:{nodes, userImage}}}
 *   delete  DELETE /api/chat/pubsubs/circle/{messageId}?userSeq=
 *
 * ⚠ Highest-risk write in the app: one call can notify the whole company. Sending (and deleting) is off unless
 * UBM_PUBSUB_SEND=1, the "all" range is always refused by this client, and with UBM_SELF_ONLY=1 the only allowed
 * target list is exactly [me] (checkForwardTarget).
 */
import { checkForwardTarget } from "./forward";
import { tk } from "../../src/lib/i18n-core";

export const PUBSUB_SEND_ENV = "UBM_PUBSUB_SEND";
export const PUBSUB_PAGE_SIZE = 10;
export const PUBSUB_MAX_TARGETS = 300;
export const PUBSUB_MAX_MESSAGE = 4000;
export const PUBSUB_SEND_DISABLED_TEXT = `공지톡 발송은 꺼져 있습니다 (${PUBSUB_SEND_ENV}=1 로 실행해야 활성화됩니다)`;
export const PUBSUB_ALL_REFUSED_TEXT = "전체 사용자 공지톡은 이 앱에서 보낼 수 없습니다";
export const PUBSUB_DELETE_CONFIRM = tk("공지톡을 삭제하시겠습니까?");

/** Original component state uses "partial" (default) and "all"; "all" is never sent by this client. */
export type PubsubRange = "partial" | "all";
export type PubsubTarget = { userId: number; name?: string };
export type PubsubNode = { nodeId: number; nodeType: string; nodeValue: string };
export type CircleBody = {
  userSeq: number;
  message: string;
  nodes: PubsubNode[];
  accessTarget: { nodes: PubsubNode[] };
};
export type PubsubItem = {
  id: number;
  message: string;
  createdAt?: string;
  companyTarget: boolean;
  confirmCount: number;
  recipientCount: number;
};
export type PubsubDetail = PubsubItem & { nodes: PubsubNode[]; userImage?: string };
export type PubsubPage = { items: PubsubItem[]; total: number; page: number; hasMore: boolean };
export type PubsubCaps = { send: boolean; delete: boolean; selfOnly: boolean; reason?: string };

type Env = Record<string, string | undefined> | undefined;

export function pubsubSendEnabled(env: Env): boolean {
  return env?.[PUBSUB_SEND_ENV] === "1";
}

export function pubsubCaps(env: Env): PubsubCaps {
  const send = pubsubSendEnabled(env);
  const selfOnly = env?.UBM_SELF_ONLY === "1";
  return {
    send,
    delete: send,
    selfOnly,
    reason: send ? (selfOnly ? tk("안전 모드: 나에게만 보낼 수 있습니다") : undefined) : PUBSUB_SEND_DISABLED_TEXT,
  };
}

function positive(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label}가 올바르지 않습니다`);
  return n;
}

function nonNegative(value: unknown): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

const enc = (n: number) => encodeURIComponent(String(n));

export function pubsubSendPath(me: unknown): string {
  return `/api/chat/pubsubs/circle?userSeq=${enc(positive(me, "사용자"))}`;
}

export function pubsubListPath(page: unknown, me: unknown): string {
  return `/api/chat/pubsubs/circle?size=${PUBSUB_PAGE_SIZE}&page=${enc(nonNegative(page))}&userSeq=${enc(positive(me, "사용자"))}`;
}

export function pubsubDetailPath(id: unknown, me: unknown): string {
  return `/api/chat/pubsubs/circle/${enc(positive(id, "공지톡"))}?userSeq=${enc(positive(me, "사용자"))}`;
}

export function pubsubDeletePath(id: unknown, me: unknown): string {
  return pubsubDetailPath(id, me);
}

/** Dedupe + validate recipients; returns user ids in pick order. */
export function normalizePubsubTargets(targets: unknown): PubsubTarget[] {
  const list = Array.isArray(targets) ? targets : [];
  const out: PubsubTarget[] = [];
  const seen = new Set<number>();
  for (const t of list) {
    const raw = t && typeof t === "object" ? (t as any).userId ?? (t as any).nodeId : t;
    const userId = positive(raw, "대상");
    if (seen.has(userId)) continue;
    seen.add(userId);
    const name = t && typeof t === "object" && (t as any).name != null ? String((t as any).name) : undefined;
    out.push({ userId, name });
  }
  if (!out.length) throw new Error("공지톡을 받을 대상을 선택하세요");
  if (out.length > PUBSUB_MAX_TARGETS) throw new Error(`한 번에 최대 ${PUBSUB_MAX_TARGETS}명까지 보낼 수 있습니다`);
  return out;
}

export function normalizePubsubMessage(message: unknown): string {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) throw new Error("공지톡 내용을 입력하세요");
  if (text.length > PUBSUB_MAX_MESSAGE) throw new Error(`공지톡은 ${PUBSUB_MAX_MESSAGE}자까지 보낼 수 있습니다`);
  return text;
}

/**
 * ⚠ UNVERIFIED against a live server. Mirrors the original renderer for a "partial" (특정사용자) send:
 *   n = {userSeq, nodes:[{nodeId, nodeType:"user", nodeValue:name}]}; extend(n, {message}); gu(n)
 *   gu: "all" !== range && extend(t, e, {accessTarget:{nodes:e.nodes}}) → body = {userSeq, nodes, message, accessTarget}
 * pubsubRange itself is not part of the original body. For range "all" gu() posts "{}" — we refuse instead.
 * Departments/circles (nodeType "department"/"subdepartment") and attachments are not supported here.
 */
export function buildCircleBody({
  message,
  targets,
  me,
  range = "partial",
}: {
  message: unknown;
  targets: unknown;
  me: unknown;
  range?: PubsubRange | string;
}): CircleBody {
  if (range !== "partial") throw new Error(PUBSUB_ALL_REFUSED_TEXT);
  const userSeq = positive(me, "사용자");
  const text = normalizePubsubMessage(message);
  const nodes = normalizePubsubTargets(targets).map((t) => ({
    nodeId: t.userId,
    nodeType: "user",
    nodeValue: t.name ?? "",
  }));
  return { userSeq, message: text, nodes, accessTarget: { nodes } };
}

/** Main-process gate for pubsub:send. Throws unless enabled, range is partial and (in safe mode) targets are [me]. */
export function checkPubsubSend({
  enabled,
  selfOnly,
  range = "partial",
  targets,
  me,
}: {
  enabled: boolean;
  selfOnly: boolean;
  range?: string;
  targets: unknown;
  me: number;
}): PubsubTarget[] {
  if (!enabled) throw new Error(PUBSUB_SEND_DISABLED_TEXT);
  if (range !== "partial") throw new Error(PUBSUB_ALL_REFUSED_TEXT);
  const list = normalizePubsubTargets(targets);
  checkForwardTarget({ selfOnly, target: { memberSeqs: list.map((t) => t.userId) }, me });
  return list;
}

/** Main-process gate for pubsub:delete in safe mode: the sent item must have been addressed only to [me]. */
export function checkPubsubDelete({
  enabled,
  selfOnly,
  detail,
  me,
}: {
  enabled: boolean;
  selfOnly: boolean;
  detail?: PubsubDetail | null;
  me: number;
}): void {
  if (!enabled) throw new Error(PUBSUB_SEND_DISABLED_TEXT);
  if (!selfOnly) return;
  if (!detail || detail.companyTarget) throw new Error("안전 모드에서는 나에게 보낸 공지톡만 삭제할 수 있습니다");
  const users = detail.nodes.filter((n) => n.nodeType === "user").map((n) => n.nodeId);
  if (users.length !== detail.nodes.length) throw new Error("안전 모드에서는 나에게 보낸 공지톡만 삭제할 수 있습니다");
  checkForwardTarget({ selfOnly, target: { memberSeqs: users }, me });
}

function parseNode(raw: unknown): PubsubNode | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const id = Number(r.nodeId ?? r.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { nodeId: id, nodeType: String(r.nodeType || "user"), nodeValue: String(r.nodeValue ?? r.name ?? "") };
}

export function parsePubsubItem(raw: unknown): PubsubItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const id = Number(r.messageId ?? r.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    message: r.message == null ? "" : String(r.message),
    createdAt: r.createdAt ? String(r.createdAt) : undefined,
    companyTarget: r.companyTarget === true || r.companyTarget === "true",
    confirmCount: nonNegative(r.confirmCount),
    recipientCount: nonNegative(r.recipientCount),
  };
}

export function parsePubsubList(raw: unknown, page = 0): PubsubPage {
  const body = raw && typeof raw === "object" ? (raw as Record<string, any>) : {};
  const data = Array.isArray(body.data) ? body.data : Array.isArray(body.data?.list) ? body.data.list : [];
  const items = data.map(parsePubsubItem).filter((x: PubsubItem | null): x is PubsubItem => !!x);
  const totalRaw = Number(body.page?.total ?? body.total);
  const total = Number.isSafeInteger(totalRaw) && totalRaw >= 0 ? totalRaw : items.length;
  const p = nonNegative(page);
  return { items, total, page: p, hasMore: (p + 1) * PUBSUB_PAGE_SIZE < total };
}

export function parsePubsubDetail(raw: unknown): PubsubDetail | null {
  const body = raw && typeof raw === "object" ? (raw as Record<string, any>) : null;
  const value = body?.data && typeof body.data === "object" ? body.data : body;
  const item = parsePubsubItem(value);
  if (!item) return null;
  const target = value.accessTarget && typeof value.accessTarget === "object" ? value.accessTarget : {};
  const nodes = (Array.isArray(target.nodes) ? target.nodes : []).map(parseNode).filter((x: PubsubNode | null): x is PubsubNode => !!x);
  return { ...item, nodes, userImage: target.userImage ? String(target.userImage) : undefined };
}
