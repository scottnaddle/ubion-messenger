import { EventEmitter } from "node:events";
import { handleOnlineStanza, splitStanzas, xmlUnescape } from "./xmpp";

/**
 * XMPP over BOSH (XEP-0124/0206) on HTTPS — the transport the DaouOffice web client uses
 * (https://<portal>/http-bind/). Same public surface/events as the TCP XmppClient:
 * start/stop/kick/setStatus/online + "state" | "presence" | "body".
 * Credentials (password / subInfo) are never logged.
 */
export type BoshOptions = {
  url: string; // https://coco.ubion.co.kr/http-bind/
  domain: string;
  username: string; // bare localpart
  password: string; // subInfo (from /api/bosh/user) or derived key
  resource: string;
  wait?: number; // seconds the server may hold a poll
  /** HTTP POST (injectable for tests). Must reject on network error. */
  post?: (url: string, body: string, timeoutMs: number) => Promise<{ status: number; text: string }>;
};

const NS = "http://jabber.org/protocol/httpbind";

export async function defaultPost(url: string, body: string, timeoutMs: number) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8" }, body, signal: ctl.signal });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(t);
  }
}

/** Parse a BOSH <body> wrapper: its attributes and the stanzas inside. */
export function parseBoshBody(text: string): { attrs: Record<string, string>; stanzas: string[] } {
  const m = /<body\b([^>]*?)(\/>|>)([\s\S]*)$/.exec(text.trim());
  if (!m) throw new Error("invalid BOSH response");
  const attrs: Record<string, string> = {};
  for (const a of m[1].matchAll(/([\w:.-]+)=(['"])(.*?)\2/g)) attrs[a[1]] = xmlUnescape(a[3]);
  if (m[2] === "/>") return { attrs, stanzas: [] };
  const inner = m[3].replace(/<\/body>\s*$/, "");
  return { attrs, stanzas: splitStanzas(inner).stanzas };
}

export class BoshClient extends EventEmitter {
  readonly transport = "bosh";
  private sid = "";
  private rid = 0;
  private requests = 2;
  private wait: number;
  private queue: string[] = [];
  private inflight = 0;
  private phase: "idle" | "connecting" | "online" = "idle";
  private stopped = true;
  private gen = 0;
  private backoff = 1000;
  private retryTimer: NodeJS.Timeout | null = null;
  private post: NonNullable<BoshOptions["post"]>;
  /** consecutive failures before ever reaching online in this start() */
  failuresBeforeOnline = 0;
  everOnline = false;
  status = "online:on";

  constructor(private opts: BoshOptions) {
    super();
    this.wait = opts.wait ?? 50;
    this.post = opts.post ?? defaultPost;
  }

  get online() {
    return this.phase === "online";
  }

  start() {
    this.stopped = false;
    void this.connect();
  }

  stop() {
    const wasOnline = this.phase === "online";
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (wasOnline && this.sid) {
      const body = `<body rid='${this.rid++}' sid='${this.sid}' type='terminate' xmlns='${NS}'><presence type='unavailable'><status>terminated PC messenger</status></presence></body>`;
      void this.post(this.opts.url, body, 5000).catch(() => undefined);
    }
    this.reset();
    this.emit("state", "offline");
  }

  kick() {
    if (this.stopped) return;
    this.backoff = 1000;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.reset();
    void this.connect();
  }

  setStatus(status: "online:on" | "away:on") {
    this.status = status;
    if (this.online) this.write(`<presence><status>${status}</status></presence>`);
  }

  private reset() {
    this.gen++;
    this.sid = "";
    this.queue = [];
    this.inflight = 0;
    this.phase = "idle";
  }

  private write(s: string) {
    if (this.phase !== "online") return;
    this.queue.push(s);
    this.pump(this.gen);
  }

  /** One HTTP round trip; returns the stanzas the server sent back. */
  private async req(g: number, payload: string, extra = ""): Promise<string[]> {
    const sid = this.sid ? ` sid='${this.sid}'` : "";
    const body = `<body rid='${this.rid++}'${sid} xmlns='${NS}'${extra}>${payload}</body>`;
    const res = await this.post(this.opts.url, body, (this.wait + 20) * 1000);
    if (g !== this.gen) throw new Error("stale");
    if (res.status !== 200) throw new Error(`BOSH HTTP ${res.status}`);
    const { attrs, stanzas } = parseBoshBody(res.text);
    if (attrs.type === "terminate") throw new Error(`BOSH terminated${attrs.condition ? ` (${attrs.condition})` : ""}`);
    if (attrs.sid) this.sid = attrs.sid;
    if (attrs.requests) this.requests = Math.max(1, Number(attrs.requests) || 2);
    if (attrs.wait) this.wait = Number(attrs.wait) || this.wait;
    return stanzas;
  }

  /** Send payload, then poll (bounded) until a stanza matching `want` arrives. Other stanzas are dispatched. */
  private async expect(g: number, payload: string, want: (s: string) => boolean, extra = ""): Promise<string> {
    let got = await this.req(g, payload, extra);
    for (let i = 0; i < 4; i++) {
      const hit = got.find(want);
      if (hit) return hit;
      got = await this.req(g, "");
    }
    throw new Error("BOSH handshake timeout");
  }

  private async connect() {
    if (this.stopped) return;
    const g = ++this.gen;
    this.sid = "";
    this.rid = Math.floor(Math.random() * 1_000_000_000) + 1;
    this.phase = "connecting";
    this.emit("state", "connecting");
    const d = this.opts.domain;
    try {
      const xb = ` xmlns:xmpp='urn:xmpp:xbosh'`;
      const f1 = await this.expect(g, "", (s) => s.startsWith("<stream:features"),
        ` content='text/xml; charset=utf-8' hold='1' to='${d}' ver='1.6' wait='${this.wait}' xml:lang='ko' xmpp:version='1.0'${xb}`);
      if (!f1.includes("PLAIN")) throw new Error("PLAIN not offered");
      const tok = Buffer.from(`\0${this.opts.username}\0${this.opts.password}`, "utf8").toString("base64");
      const a = await this.expect(g, `<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>${tok}</auth>`, (s) => s.startsWith("<success") || s.startsWith("<failure"));
      if (a.startsWith("<failure")) {
        this.stopped = true; // wrong credentials — don't hammer
        this.emit("state", "offline", "XMPP 인증 실패");
        this.reset();
        return;
      }
      await this.expect(g, "", (s) => s.startsWith("<stream:features"), ` to='${d}' xml:lang='ko' xmpp:restart='true'${xb}`);
      const b = await this.expect(g, `<iq type='set' id='bind1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><resource>${this.opts.resource}</resource></bind></iq>`, (s) => s.startsWith("<iq") && s.includes("bind1"));
      if (!b.includes("<jid>")) throw new Error("bind failed");
      await this.expect(g, "<iq type='set' id='sess1'><session xmlns='urn:ietf:params:xml:ns:xmpp-session'/></iq>", (s) => s.startsWith("<iq") && s.includes("sess1"));
      if (g !== this.gen) return;
      this.phase = "online";
      this.backoff = 1000;
      this.failuresBeforeOnline = 0;
      this.everOnline = true;
      this.queue.push(`<presence><status>${this.status}</status></presence>`, "<iq type='set' id='carbons1'><enable xmlns='urn:xmpp:carbons:2'/></iq>");
      this.emit("state", "online");
      this.pump(g);
    } catch (e) {
      if (g === this.gen) this.onFail((e as Error).message);
    }
  }

  /** Keep exactly one long-poll outstanding; use the 2nd slot when there is something to send. */
  private pump(g: number) {
    while (!this.stopped && g === this.gen && this.phase === "online" && (this.inflight < 1 || (this.queue.length > 0 && this.inflight < this.requests))) {
      const payload = this.queue.splice(0).join("");
      this.inflight++;
      this.req(g, payload).then(
        (stanzas) => {
          if (g !== this.gen) return;
          this.inflight--;
          for (const s of stanzas) {
            try {
              handleOnlineStanza(s, { write: (x) => this.write(x), domain: this.opts.domain, emit: (ev, p) => this.emit(ev, p) });
            } catch {
              /* never let one stanza kill the session */
            }
          }
          this.pump(g);
        },
        (e) => {
          if (g === this.gen) this.onFail((e as Error).message);
        }
      );
    }
  }

  private onFail(reason: string) {
    if (!this.everOnline) this.failuresBeforeOnline++;
    this.reset();
    if (this.stopped) return;
    this.emit("state", "offline", reason);
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    this.retryTimer = setTimeout(() => void this.connect(), wait);
  }
}
