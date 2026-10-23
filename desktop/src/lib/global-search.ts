/** 통합 검색: shared (renderer + main) query/result shapes and pure merge helpers. */

export type FileKind = "file" | "image";

/** Renderer → main query. Dates are local calendar days (YYYY-MM-DD, inclusive). */
export type GlobalSearchQuery = {
  keyword?: string;
  from?: string;
  to?: string;
  senderSeq?: number;
  files?: FileKind;
};

export type SearchHit = {
  roomKey: string;
  messageId: number;
  sendUserSeq?: number;
  sendUserName: string;
  message: string;
  createdAt?: string;
  attach?: { name: string; cryptId?: string; size?: number; image?: boolean };
  source: "local" | "server";
};

export type GlobalSearchProgress = {
  searchId: number;
  /** New/updated hits since the previous progress event (merge with mergeHits). */
  hits: SearchHit[];
  searchedRooms: number;
  totalRooms: number;
  phase: "local" | "server" | "done";
};

export type GlobalSearchResult = {
  searchId: number;
  hits: SearchHit[];
  searchedRooms: number;
  totalRooms: number;
  failedRooms: number;
  cancelled: boolean;
  /** False when the server fan-out was skipped (flag off, or the filters can't be sent to the server). */
  serverSearched: boolean;
};

export type GlobalSearchCaps = {
  server: boolean;
  dateRange: boolean;
  maxRooms: number;
  /** Local cache engine ("inverted-index-json": pure-TS bigram index persisted in userData). */
  localEngine: string;
};

export const MAX_KEYWORD_LENGTH = 100;

function hitTime(h: SearchHit): number {
  const t = h.createdAt ? new Date(h.createdAt).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** Newest first, ties by messageId. */
export function sortHits(hits: SearchHit[]): SearchHit[] {
  return [...hits].sort((a, b) => hitTime(b) - hitTime(a) || b.messageId - a.messageId);
}

/** Dedupe by messageId; a server hit replaces a cached local one (fresher, authoritative). */
export function mergeHits(existing: SearchHit[], incoming: SearchHit[]): SearchHit[] {
  const m = new Map<number, SearchHit>();
  for (const h of existing) m.set(h.messageId, h);
  for (const h of incoming) {
    const prev = m.get(h.messageId);
    if (!prev || h.source === "server" || prev.source === "local") m.set(h.messageId, prev && !h.attach && prev.attach ? { ...h, attach: prev.attach } : h);
  }
  return sortHits([...m.values()]);
}

export type HitGroup = { roomKey: string; hits: SearchHit[] };

/** Group by room, rooms ordered by their newest hit. */
export function groupHitsByRoom(hits: SearchHit[]): HitGroup[] {
  const groups = new Map<string, SearchHit[]>();
  for (const h of sortHits(hits)) {
    let g = groups.get(h.roomKey);
    if (!g) groups.set(h.roomKey, (g = []));
    g.push(h);
  }
  return [...groups].map(([roomKey, list]) => ({ roomKey, hits: list }));
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate + normalize renderer input. A single date means that one day. Throws when nothing to search for. */
export function normalizeGlobalQuery(raw: unknown): GlobalSearchQuery {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const q: GlobalSearchQuery = {};
  const kw = typeof r.keyword === "string" ? r.keyword.replace(/\s+/g, " ").trim() : "";
  if (kw) q.keyword = kw.slice(0, MAX_KEYWORD_LENGTH);
  let from = typeof r.from === "string" && DAY_RE.test(r.from) ? r.from : undefined;
  let to = typeof r.to === "string" && DAY_RE.test(r.to) ? r.to : undefined;
  if (from && !to) to = from;
  if (to && !from) from = to;
  if (from && to) {
    if (from > to) [from, to] = [to, from];
    q.from = from;
    q.to = to;
  }
  const s = typeof r.senderSeq === "number" ? r.senderSeq : typeof r.senderSeq === "string" && r.senderSeq ? Number(r.senderSeq) : NaN;
  if (Number.isSafeInteger(s) && s > 0) q.senderSeq = s;
  if (r.files === "file" || r.files === "image") q.files = r.files;
  if (!q.keyword && !q.from && q.senderSeq == null && !q.files) throw new Error("검색어나 필터를 입력하세요");
  return q;
}
