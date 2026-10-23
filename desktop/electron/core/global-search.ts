import { normalizeAttach } from "./attach";
import { normalizeRestMessage, roomTime } from "./daou-client";
import { matchesFilters, normalizeText, type IndexedDoc, type LocalQuery, type LocalSearchIndex } from "./search-index";
import type { ChatMessage, Room, RoomKind } from "./types";
import {
  mergeHits, type FileKind, type GlobalSearchCaps, type GlobalSearchProgress, type GlobalSearchQuery, type GlobalSearchResult, type SearchHit,
} from "../../src/lib/global-search";

/**
 * 통합 검색 (main process). DaouOffice has no cross-room search API, so this fans out over the per-room
 * GET /api/chat/{seq}/search (and /api/chat/{buddies|rooms|pubsubs}/attaches/{seq} for the file filter),
 * recent rooms first, throttled, cancellable, and merges with the local cache (search-index.ts).
 * Request shapes mirror the official client (renderer.prod.js @859073, @436949).
 */

export const SEARCH_PAGE_SIZE = 20; // official client: offset=20
export const ATTACH_PAGE_SIZE = 50;
export const DEFAULT_MAX_ROOMS = 60;
export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_MIN_INTERVAL_MS = 250;

const ROOM_TYPE: Partial<Record<RoomKind, "single" | "room" | "pubsub">> = { buddy: "single", room: "room", pubsub: "pubsub" };
const ATTACH_KIND: Partial<Record<RoomKind, string>> = { buddy: "chat/buddies", room: "chat/rooms", pubsub: "chat/pubsubs" };

/** Server fan-out is read-only with verified shapes; UBM_GLOBAL_SEARCH_SERVER=0 turns it off (local cache only). */
export function globalSearchServerEnabled(env: Record<string, string | undefined>): boolean {
  return env.UBM_GLOBAL_SEARCH_SERVER !== "0";
}

/** The official client only ever sends a single day; multi-day fromDate/toDate is unverified → UBM_SEARCH_DATE_RANGE=1. */
export function searchDateRangeEnabled(env: Record<string, string | undefined>): boolean {
  return env.UBM_SEARCH_DATE_RANGE === "1";
}

export function globalSearchMaxRooms(env: Record<string, string | undefined>): number {
  const n = Number(env.UBM_SEARCH_MAX_ROOMS);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 500) : DEFAULT_MAX_ROOMS;
}

export function globalSearchCaps(env: Record<string, string | undefined>): GlobalSearchCaps {
  return {
    server: globalSearchServerEnabled(env),
    dateRange: searchDateRangeEnabled(env),
    maxRooms: globalSearchMaxRooms(env),
    localEngine: "inverted-index-json",
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** moment().format("YYYY-MM-DDTHH:mm:ss.SSSZ") in local time, e.g. 2026-10-24T00:00:00.000+09:00. */
export function formatSearchDate(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Local start (00:00:00.000) or end (23:59:59.999) of a YYYY-MM-DD day. */
export function dayBound(ymd: string, end: boolean): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0);
}

export function localQueryOf(q: GlobalSearchQuery, roomKeys?: string[]): LocalQuery {
  return {
    keyword: q.keyword,
    fromMs: q.from ? dayBound(q.from, false).getTime() : undefined,
    toMs: q.to ? dayBound(q.to, true).getTime() : undefined,
    senderSeq: q.senderSeq,
    files: q.files,
    roomKeys,
  };
}

export type RoomSearchParams = {
  roomSeq: number;
  roomType: "single" | "room" | "pubsub";
  userSeq: number;
  page?: number;
  keyword?: string;
  from?: Date;
  to?: Date;
  sendUserSeq?: number;
};

/**
 * GET /api/chat/{roomSeq}/search?offset=20&page=&userSeq=[&keyword=][&fromDate=&toDate=][&sendUserSeq=]&roomType=
 * Same order as the official client. null when there is nothing to search for (the official client skips the call too).
 * keyword: encodeURIComponent (official uses encodeURI; identical for normal text, but safe for & # + ?).
 */
export function buildRoomSearchPath(p: RoomSearchParams): string | null {
  const keyword = p.keyword?.trim();
  if (!keyword && !p.from && p.sendUserSeq == null) return null;
  let path = `/api/chat/${p.roomSeq}/search?offset=${SEARCH_PAGE_SIZE}&page=${p.page ?? 0}&userSeq=${p.userSeq}`;
  if (keyword) path += `&keyword=${encodeURIComponent(keyword)}`;
  if (p.from) {
    path += `&fromDate=${encodeURIComponent(formatSearchDate(p.from))}`;
    path += `&toDate=${encodeURIComponent(formatSearchDate(p.to ?? p.from))}`;
  }
  if (p.sendUserSeq != null) path += `&sendUserSeq=${p.sendUserSeq}`;
  return path + `&roomType=${p.roomType}`;
}

/** GET /api/chat/{buddies|rooms|pubsubs}/attaches/{seq}?size=&attachType=file|image&userSeq=[&criteriaMessageId=] */
export function buildAttachesPath(p: {
  kind: RoomKind; seq: number; userSeq: number; attachType: FileKind; size?: number; criteriaMessageId?: number;
}): string | null {
  const base = ATTACH_KIND[p.kind];
  if (!base) return null;
  let path = `/api/${base}/attaches/${p.seq}?size=${p.size ?? ATTACH_PAGE_SIZE}&attachType=${p.attachType}&userSeq=${p.userSeq}`;
  if (p.criteriaMessageId != null) path += `&criteriaMessageId=${p.criteriaMessageId}`;
  return path;
}

/**
 * Server-side date filter: the verified single-day form, or any range when UBM_SEARCH_DATE_RANGE=1.
 * Otherwise null (results are still date-filtered client side).
 */
export function serverDates(q: GlobalSearchQuery, rangeEnabled: boolean): { from: Date; to: Date } | null {
  if (!q.from || !q.to) return null;
  if (q.from !== q.to && !rangeEnabled) return null;
  return { from: dayBound(q.from, false), to: dayBound(q.to, true) };
}

/** Searchable rooms, most recent message first (pins don't matter here), capped. */
export function orderRoomsForSearch(rooms: Room[], maxRooms: number): Room[] {
  return rooms
    .filter((r) => ROOM_TYPE[r.kind] && Number.isSafeInteger(r.seq) && r.seq > 0)
    .sort((a, b) => roomTime(b) - roomTime(a))
    .slice(0, Math.max(0, maxRooms));
}

export type RateLimiter = {
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
};

/** At most `concurrency` tasks in flight, and task starts spaced at least `minIntervalMs` apart. */
export function createRateLimiter(o: {
  concurrency: number;
  minIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): RateLimiter {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const limit = Math.max(1, o.concurrency);
  let active = 0;
  let nextStart = -Infinity;
  const waiters: (() => void)[] = [];
  return {
    async run(fn, signal) {
      while (active >= limit) await new Promise<void>((r) => waiters.push(r));
      active++;
      try {
        const t = now();
        const start = Math.max(t, nextStart);
        nextStart = start + o.minIntervalMs;
        if (start > t) await sleep(start - t);
        if (signal?.aborted) throw new SearchCancelled();
        return await fn();
      } finally {
        active--;
        waiters.shift()?.();
      }
    },
  };
}

export class SearchCancelled extends Error {
  constructor() {
    super("검색이 취소되었습니다");
  }
}

export function hitFromDoc(d: IndexedDoc, source: SearchHit["source"]): SearchHit {
  const h: SearchHit = {
    roomKey: d.roomKey, messageId: d.messageId, sendUserName: d.sendUserName, message: d.message, createdAt: d.createdAt, source,
  };
  if (d.sendUserSeq != null) h.sendUserSeq = d.sendUserSeq;
  if (d.attachName) h.attach = { name: d.attachName, cryptId: d.attachCryptId, size: d.attachSize, image: d.imageFile || undefined };
  return h;
}

export function hitFromMessage(roomKey: string, m: ChatMessage, source: SearchHit["source"]): SearchHit | null {
  if (m.messageId == null || m.deleted) return null;
  return hitFromDoc(
    {
      messageId: m.messageId, roomKey, sendUserSeq: m.sendUserSeq, sendUserName: m.sendUserName, message: m.message,
      createdAt: m.createdAt, attachName: m.attach?.name, attachCryptId: m.attach?.cryptId, attachSize: m.attach?.size,
      imageFile: m.attach?.imageFile,
    },
    source
  );
}

/** Attaches API rows: { chatMessageAttachFileModel: { itemId, fileName, fileSize, filePhotoPath… }, messageId, sendUserSeq, … }. */
export function parseAttachRows(body: any, roomKey: string): ChatMessage[] {
  const rows = Array.isArray(body?.data) ? body.data : [];
  const out: ChatMessage[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const a = r.chatMessageAttachFileModel || {};
    const model = {
      ...a,
      cryptId: a.cryptId ?? a.itemId,
      name: a.name ?? a.fileName,
      size: a.size ?? a.fileSize,
      imageFile: a.imageFile ?? !!a.filePhotoPath,
    };
    const m = normalizeRestMessage({ ...r, message: r.message ?? "", chatMessageAttachFileModel: model }, roomKey);
    if (!m.attach) m.attach = normalizeAttach(model);
    if (m.attach) out.push(m);
  }
  return out;
}

export type GlobalSearchDeps = {
  searchId: number;
  rooms: Room[];
  userSeq: number;
  /** Read-only GET returning parsed JSON. */
  getJson: (path: string) => Promise<any>;
  index?: LocalSearchIndex;
  limiter: RateLimiter;
  maxRooms: number;
  serverEnabled: boolean;
  dateRangeEnabled: boolean;
  signal?: AbortSignal;
  onProgress?: (p: GlobalSearchProgress) => void;
  onRoomError?: (room: Room, e: unknown) => void;
  localLimit?: number;
};

/** Can the server be asked at all for this query? (files → attaches API; else needs keyword/sender/single-day date.) */
export function serverPlan(q: GlobalSearchQuery, rangeEnabled: boolean): { mode: "files" | "search"; dates: { from: Date; to: Date } | null } | null {
  if (q.files) return { mode: "files", dates: null };
  const dates = serverDates(q, rangeEnabled);
  if (!q.keyword && q.senderSeq == null && !dates) return null;
  return { mode: "search", dates };
}

export async function runGlobalSearch(q: GlobalSearchQuery, deps: GlobalSearchDeps): Promise<GlobalSearchResult> {
  const lq = localQueryOf(q);
  let hits: SearchHit[] = [];
  const emit = (delta: SearchHit[], searchedRooms: number, totalRooms: number, phase: GlobalSearchProgress["phase"]) =>
    deps.onProgress?.({ searchId: deps.searchId, hits: delta, searchedRooms, totalRooms, phase });

  // 1) local cache first (instant)
  if (deps.index) {
    const local = deps.index.search(lq, deps.localLimit ?? 300).map((d) => hitFromDoc(d, "local"));
    hits = mergeHits(hits, local);
    emit(local, 0, 0, "local");
  }

  const plan = deps.serverEnabled ? serverPlan(q, deps.dateRangeEnabled) : null;
  const rooms = plan ? orderRoomsForSearch(deps.rooms, deps.maxRooms) : [];
  let searched = 0;
  let failed = 0;
  const kw = normalizeText(q.keyword || "");

  const searchRoom = async (room: Room) => {
    let list: ChatMessage[];
    if (plan!.mode === "files") {
      const path = buildAttachesPath({ kind: room.kind, seq: room.seq, userSeq: deps.userSeq, attachType: q.files! });
      list = path ? parseAttachRows(await deps.getJson(path), room.key) : [];
      for (const m of list) if (deps.index && m.messageId != null && !deps.index.has(m.messageId)) deps.index.add(room.key, [m]);
    } else {
      const path = buildRoomSearchPath({
        roomSeq: room.seq, roomType: ROOM_TYPE[room.kind]!, userSeq: deps.userSeq, keyword: q.keyword,
        from: plan!.dates?.from, to: plan!.dates?.to, sendUserSeq: q.senderSeq,
      });
      if (!path) return [];
      const body = await deps.getJson(path);
      list = (Array.isArray(body?.data) ? body.data : []).map((m: Record<string, unknown>) => normalizeRestMessage(m, room.key));
      deps.index?.add(room.key, list);
    }
    const out: SearchHit[] = [];
    for (const m of list) {
      const h = hitFromMessage(room.key, m, "server");
      if (!h) continue;
      // Client-side filters: dates not sent to the server, and file-name keyword for the attaches API.
      if (!matchesFilters({ ...h, attachName: h.attach?.name, imageFile: h.attach?.image }, { ...lq, keyword: undefined, files: undefined })) continue;
      if (plan!.mode === "files" && kw && !normalizeText(h.attach?.name || "").includes(kw)) continue;
      out.push(h);
    }
    return out;
  };

  let cancelled = !!deps.signal?.aborted;
  if (plan && !cancelled) {
    emit([], 0, rooms.length, "server");
    await Promise.all(
      rooms.map((room) =>
        deps.limiter
          .run(() => searchRoom(room), deps.signal)
          .then(
            (found) => {
              searched++;
              if (deps.signal?.aborted) return;
              hits = mergeHits(hits, found);
              emit(found, searched, rooms.length, "server");
            },
            (e) => {
              if (e instanceof SearchCancelled) return;
              searched++;
              failed++;
              deps.onRoomError?.(room, e);
            }
          )
      )
    );
    cancelled = !!deps.signal?.aborted;
  }
  emit([], searched, rooms.length, "done");
  return { searchId: deps.searchId, hits, searchedRooms: searched, totalRooms: rooms.length, failedRooms: failed, cancelled, serverSearched: !!plan };
}
