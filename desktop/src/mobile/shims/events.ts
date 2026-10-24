/** Tiny browser EventEmitter for any `node:events` import pulled into the mobile bundle. */
type Fn = (...args: any[]) => void;

export class EventEmitter {
  private map = new Map<string | symbol, Fn[]>();
  on(e: string | symbol, fn: Fn) {
    this.map.set(e, [...(this.map.get(e) || []), fn]);
    return this;
  }
  addListener(e: string | symbol, fn: Fn) {
    return this.on(e, fn);
  }
  once(e: string | symbol, fn: Fn) {
    const w: Fn = (...a) => {
      this.off(e, w);
      fn(...a);
    };
    return this.on(e, w);
  }
  off(e: string | symbol, fn: Fn) {
    this.map.set(e, (this.map.get(e) || []).filter((f) => f !== fn));
    return this;
  }
  removeListener(e: string | symbol, fn: Fn) {
    return this.off(e, fn);
  }
  removeAllListeners(e?: string | symbol) {
    if (e === undefined) this.map.clear();
    else this.map.delete(e);
    return this;
  }
  emit(e: string | symbol, ...args: unknown[]) {
    const l = this.map.get(e);
    if (!l?.length) return false;
    for (const f of [...l]) f(...args);
    return true;
  }
  listenerCount(e: string | symbol) {
    return this.map.get(e)?.length ?? 0;
  }
  setMaxListeners(_n: number) {
    return this;
  }
}

export default EventEmitter;
