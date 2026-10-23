import type { ChatMessage } from "./types";

/**
 * 통합 검색 로컬 캐시 (client-local, never uploaded).
 *
 * Electron 33 ships Node 20 (no node:sqlite) and no native sqlite module is bundled, so this is a pure-TS
 * inverted index over character bigrams (Korean-friendly substring search), persisted as JSON in userData.
 * Only the docs are persisted; postings are rebuilt on load.
 */
export type IndexedDoc = {
  messageId: number;
  roomKey: string;
  sendUserSeq?: number;
  sendUserName: string;
  message: string;
  createdAt?: string;
  attachName?: string;
  attachCryptId?: string;
  attachSize?: number;
  imageFile?: boolean;
};

export type LocalQuery = {
  keyword?: string;
  /** Inclusive epoch-ms bounds. */
  fromMs?: number;
  toMs?: number;
  senderSeq?: number;
  /** Only messages carrying an attachment (keyword then matches the file name). */
  files?: "file" | "image";
  roomKeys?: string[];
};

export const SEARCH_INDEX_VERSION = 1;
export const SEARCH_INDEX_MAX_DOCS = 50_000;

/** NFC + lowercase + collapse whitespace: "Hello  World" ≈ "hello world"; 한글 jamo forms unified. */
export function normalizeText(s: string): string {
  return String(s || "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Character bigrams of the whitespace-stripped text (unigram for 1-char text). */
export function bigrams(s: string): string[] {
  const chars = Array.from(normalizeText(s).replace(/\s/g, ""));
  if (chars.length === 1) return chars;
  const out = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
  return [...out];
}

export function docTime(d: { createdAt?: string }): number {
  const t = d.createdAt ? new Date(d.createdAt).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export function docFromMessage(roomKey: string, m: ChatMessage): IndexedDoc | null {
  if (m.messageId == null || !Number.isFinite(m.messageId) || m.deleted || m.pending || m.failed) return null;
  const doc: IndexedDoc = {
    messageId: m.messageId,
    roomKey,
    sendUserName: m.sendUserName || "",
    message: m.message || "",
    createdAt: m.createdAt,
  };
  if (m.sendUserSeq != null) doc.sendUserSeq = m.sendUserSeq;
  if (m.attach?.name) {
    doc.attachName = m.attach.name;
    doc.attachCryptId = m.attach.cryptId;
    if (m.attach.size != null) doc.attachSize = m.attach.size;
    if (m.attach.imageFile) doc.imageFile = true;
  }
  return doc;
}

/** Does the doc satisfy every non-keyword filter? */
export function matchesFilters(d: IndexedDoc, q: LocalQuery): boolean {
  if (q.roomKeys && !q.roomKeys.includes(d.roomKey)) return false;
  if (q.senderSeq != null && d.sendUserSeq !== q.senderSeq) return false;
  if (q.fromMs != null || q.toMs != null) {
    const t = docTime(d);
    if (!t) return false;
    if (q.fromMs != null && t < q.fromMs) return false;
    if (q.toMs != null && t > q.toMs) return false;
  }
  if (q.files) {
    if (!d.attachName) return false;
    if (q.files === "image" ? !d.imageFile : d.imageFile) return false;
  }
  return true;
}

export class LocalSearchIndex {
  private docs = new Map<number, IndexedDoc>();
  private postings = new Map<string, Set<number>>();
  private dirty = false;

  constructor(private readonly maxDocs = SEARCH_INDEX_MAX_DOCS) {}

  get size() {
    return this.docs.size;
  }

  has(messageId: number) {
    return this.docs.has(messageId);
  }

  get isDirty() {
    return this.dirty;
  }

  private textOf(d: IndexedDoc) {
    return d.attachName ? `${d.message} ${d.attachName}` : d.message;
  }

  private unpost(d: IndexedDoc) {
    for (const g of bigrams(this.textOf(d))) {
      const set = this.postings.get(g);
      if (!set) continue;
      set.delete(d.messageId);
      if (!set.size) this.postings.delete(g);
    }
  }

  private put(d: IndexedDoc) {
    const prev = this.docs.get(d.messageId);
    if (prev) {
      if (this.textOf(prev) === this.textOf(d) && prev.roomKey === d.roomKey && prev.createdAt === d.createdAt) return false;
      this.unpost(prev);
    }
    this.docs.set(d.messageId, d);
    for (const g of bigrams(this.textOf(d))) {
      let set = this.postings.get(g);
      if (!set) this.postings.set(g, (set = new Set()));
      set.add(d.messageId);
    }
    return true;
  }

  remove(messageId: number) {
    const d = this.docs.get(messageId);
    if (!d) return;
    this.unpost(d);
    this.docs.delete(messageId);
    this.dirty = true;
  }

  /** Index fetched/received messages; deleted (tombstoned) ones are dropped from the cache. */
  add(roomKey: string, list: ChatMessage[]): number {
    let n = 0;
    for (const m of list) {
      if (m.deleted && m.messageId != null) {
        this.remove(m.messageId);
        continue;
      }
      const d = docFromMessage(m.roomKey || roomKey, m);
      if (d && this.put(d)) n++;
    }
    if (n) {
      this.dirty = true;
      this.evict();
    }
    return n;
  }

  addDocs(list: IndexedDoc[]) {
    let n = 0;
    for (const d of list) if (d && Number.isFinite(d.messageId) && d.roomKey && this.put(d)) n++;
    if (n) {
      this.dirty = true;
      this.evict();
    }
    return n;
  }

  /** Keep the newest maxDocs messages. */
  private evict() {
    if (this.docs.size <= this.maxDocs) return;
    const sorted = [...this.docs.values()].sort((a, b) => docTime(a) - docTime(b) || a.messageId - b.messageId);
    for (const d of sorted.slice(0, this.docs.size - this.maxDocs)) {
      this.unpost(d);
      this.docs.delete(d.messageId);
    }
  }

  /** Substring match (case-insensitive) on message text, or on the file name when q.files is set. Newest first. */
  search(q: LocalQuery, limit = 200): IndexedDoc[] {
    const kw = normalizeText(q.keyword || "");
    let candidates: Iterable<IndexedDoc>;
    if (kw) {
      const grams = bigrams(kw);
      let ids: Set<number> | null = null;
      if (grams.length && Array.from(kw.replace(/\s/g, "")).length >= 2) {
        for (const g of grams) {
          const set = this.postings.get(g);
          if (!set) return [];
          if (!ids) ids = new Set(set);
          else for (const id of ids) if (!set.has(id)) ids.delete(id);
          if (!ids.size) return [];
        }
      }
      const pool: Iterable<IndexedDoc> = ids ? [...ids].map((id) => this.docs.get(id)!) : this.docs.values();
      const hay = (d: IndexedDoc) => normalizeText(q.files ? d.attachName || "" : this.textOf(d));
      candidates = [...pool].filter((d) => hay(d).includes(kw));
    } else {
      candidates = this.docs.values();
    }
    const out: IndexedDoc[] = [];
    for (const d of candidates) if (matchesFilters(d, q)) out.push(d);
    out.sort((a, b) => docTime(b) - docTime(a) || b.messageId - a.messageId);
    return out.slice(0, limit);
  }

  clear() {
    this.docs.clear();
    this.postings.clear();
    this.dirty = true;
  }

  toJSON(): string {
    return JSON.stringify({ v: SEARCH_INDEX_VERSION, docs: [...this.docs.values()] });
  }

  markSaved() {
    this.dirty = false;
  }

  /** Corrupt / foreign-version files load as empty (it's only a cache). */
  static fromJSON(text: string | null | undefined, maxDocs = SEARCH_INDEX_MAX_DOCS): LocalSearchIndex {
    const idx = new LocalSearchIndex(maxDocs);
    if (!text) return idx;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.v === SEARCH_INDEX_VERSION && Array.isArray(parsed.docs)) {
        idx.addDocs(parsed.docs.filter((d: any) => d && typeof d.messageId === "number" && typeof d.roomKey === "string" && typeof d.message === "string"));
      }
    } catch {
      /* empty cache */
    }
    idx.dirty = false;
    return idx;
  }
}
