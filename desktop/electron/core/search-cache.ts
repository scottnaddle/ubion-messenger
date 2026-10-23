import { LocalSearchIndex } from "./search-index";

/** Minimal fs surface (node:fs) so persistence is unit-testable. */
export type CacheFs = {
  readFileSync(p: string, enc: "utf8"): string;
  writeFileSync(p: string, data: string, opts?: { mode?: number }): void;
  renameSync(a: string, b: string): void;
  mkdirSync(p: string, opts: { recursive: true }): unknown;
  rmSync(p: string, opts: { force: true; recursive?: boolean }): void;
};

/**
 * Per-account local search cache file: <userData>/search-cache/<userSeq>.json (mode 0600).
 * Client-local only — nothing here is ever uploaded. Saves are debounced; flush() on quit/logout.
 */
export class SearchCacheStore {
  private uid: number | null = null;
  private index: LocalSearchIndex | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dir: string,
    private readonly fs: CacheFs,
    private readonly opts: { debounceMs?: number; join?: (...p: string[]) => string; maxDocs?: number } = {}
  ) {}

  private file(uid: number) {
    const join = this.opts.join ?? ((...p: string[]) => p.join("/"));
    return join(this.dir, `${uid}.json`);
  }

  /** Index for the logged-in user (loads lazily; switching accounts flushes the previous one). */
  for(uid: number | null | undefined): LocalSearchIndex | null {
    if (uid == null || !Number.isSafeInteger(uid) || uid <= 0) return null;
    if (this.uid === uid && this.index) return this.index;
    this.flush();
    let text: string | null = null;
    try {
      text = this.fs.readFileSync(this.file(uid), "utf8");
    } catch {
      /* no cache yet */
    }
    this.uid = uid;
    this.index = LocalSearchIndex.fromJSON(text, this.opts.maxDocs);
    return this.index;
  }

  scheduleSave() {
    if (!this.index?.isDirty || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.opts.debounceMs ?? 3000);
    (this.timer as any)?.unref?.();
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.index || this.uid == null || !this.index.isDirty) return;
    const f = this.file(this.uid);
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
      this.fs.writeFileSync(f + ".tmp", this.index.toJSON(), { mode: 0o600 });
      this.fs.renameSync(f + ".tmp", f);
      this.index.markSaved();
    } catch {
      /* cache only; retry on next change */
    }
  }

  /** 설정 → 검색 캐시 삭제: drop every account's cache file and the in-memory index. */
  clear() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.index?.clear();
    this.index?.markSaved();
    try {
      this.fs.rmSync(this.dir, { force: true, recursive: true });
    } catch {
      /* ignore */
    }
  }

  size() {
    return this.index?.size ?? 0;
  }
}
