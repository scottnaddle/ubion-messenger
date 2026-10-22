/** In-memory LRU for authenticated media (thumbnails/avatars) served via ubion-media://. */
export type MediaEntry = { data: Buffer; contentType: string };
export class MediaCache {
  private map = new Map<string, MediaEntry>();
  private bytes = 0;
  constructor(private maxBytes: number, private maxItemBytes: number) {}
  get(key: string): MediaEntry | undefined {
    const e = this.map.get(key);
    if (e) { this.map.delete(key); this.map.set(key, e); }
    return e;
  }
  set(key: string, e: MediaEntry) {
    if (e.data.length > this.maxItemBytes) return;
    const old = this.map.get(key);
    if (old) { this.bytes -= old.data.length; this.map.delete(key); }
    this.map.set(key, e);
    this.bytes += e.data.length;
    while (this.bytes > this.maxBytes && this.map.size) {
      const k = this.map.keys().next().value!;
      this.bytes -= this.map.get(k)!.data.length;
      this.map.delete(k);
    }
  }
  clear() { this.map.clear(); this.bytes = 0; }
  get size() { return this.bytes; }
}
