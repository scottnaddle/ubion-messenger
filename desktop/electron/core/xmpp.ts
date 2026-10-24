import net from "node:net";
import { EventEmitter } from "node:events";
import { parseBotStatus, type ParsedBotStatus } from "../../src/lib/bot-status";
import { flavorProfile } from "./flavor";
import { parseStatusMessage, presenceStanza } from "./status-message";

export { presenceStanza } from "./status-message";

export type XmppOptions = {
  host: string;
  port: number;
  domain: string;
  username: string; // bare localpart (repId)
  password: string; // derived key — never logged
  resource: string;
};

export type XmppEvents = {
  state: (s: "connecting" | "online" | "offline", err?: string) => void;
  body: (obj: Record<string, any>) => void;
  presence: (p: { local: string; resource: string; type?: string; status?: string; show?: string; statusText?: string | null }) => void;
  botStatus: (p: ParsedBotStatus) => void;
};

/** Presence stanza builder is provided by status-message.ts and re-exported above. */

export function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}=(['"])(.*?)\\1`).exec(tag);
  return m ? xmlUnescape(m[2]) : undefined;
}

/**
 * Extract complete top-level stanzas from a stream buffer.
 * Handles self-closing stanzas and nested same-name tags poorly-formed servers don't send.
 */
export function splitStanzas(buf: string): { stanzas: string[]; rest: string } {
  const stanzas: string[] = [];
  let i = 0;
  for (;;) {
    const start = buf.indexOf("<", i);
    if (start < 0) return { stanzas, rest: "" };
    if (buf.startsWith("<?xml", start)) {
      const e = buf.indexOf("?>", start);
      if (e < 0) return { stanzas, rest: buf.slice(start) };
      i = e + 2;
      continue;
    }
    if (buf.startsWith("<stream:stream", start)) {
      const e = buf.indexOf(">", start);
      if (e < 0) return { stanzas, rest: buf.slice(start) };
      stanzas.push(buf.slice(start, e + 1));
      i = e + 1;
      continue;
    }
    if (buf.startsWith("</stream:stream", start)) {
      stanzas.push("</stream:stream>");
      i = buf.indexOf(">", start) + 1;
      continue;
    }
    const nm = /^<([a-zA-Z0-9:_-]+)/.exec(buf.slice(start, start + 64));
    if (!nm) {
      i = start + 1;
      continue;
    }
    const name = nm[1];
    const openEnd = buf.indexOf(">", start);
    if (openEnd < 0) return { stanzas, rest: buf.slice(start) };
    if (buf[openEnd - 1] === "/") {
      stanzas.push(buf.slice(start, openEnd + 1));
      i = openEnd + 1;
      continue;
    }
    // find matching close accounting for nesting of same name
    let depth = 1;
    let j = openEnd + 1;
    const re = new RegExp(`<(/?)${name.replace(":", "\\:")}(?=[\\s>/])[^>]*?(/?)>`, "g");
    re.lastIndex = j;
    let m: RegExpExecArray | null;
    let end = -1;
    while ((m = re.exec(buf))) {
      if (m[1] === "/") depth--;
      else if (m[2] !== "/") depth++;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    }
    if (end < 0) return { stanzas, rest: buf.slice(start) };
    stanzas.push(buf.slice(start, end));
    i = end;
  }
}

/** Minimal plain-TCP XMPP client for Openfire (no STARTTLS, SASL PLAIN), with backoff reconnect. */
export class XmppClient extends EventEmitter {
  private sock: net.Socket | null = null;
  private buf = "";
  private phase: "idle" | "features1" | "auth" | "features2" | "bind" | "session" | "online" = "idle";
  private stopped = true;
  private backoff = 1000;
  private pingTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private lastRx = 0;
  status = "online:on";

  constructor(private opts: XmppOptions) {
    super();
  }

  get online() {
    return this.phase === "online";
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown(true);
    this.emit("state", "offline");
  }

  /** Force a fresh connection (e.g. after resume from sleep / network change). */
  kick() {
    if (this.stopped) return;
    this.backoff = 1000;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.teardown(false);
    this.connect();
  }

  setStatus(status: "online:on" | "away:on") {
    this.status = status;
    if (this.online) this.write(presenceStanza(status));
  }

  /** Re-send presence carrying a free-text status message (keeps the current away/online code). */
  setStatusMessage(text: string) {
    if (this.online) this.write(presenceStanza(this.status as "online:on" | "away:on", text));
  }

  private write(s: string) {
    try {
      this.sock?.write(s);
    } catch {
      /* ignore */
    }
  }

  private openStream() {
    this.write(
      `<?xml version='1.0'?><stream:stream to='${this.opts.domain}' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>`
    );
  }

  private connect() {
    if (this.stopped) return;
    this.emit("state", "connecting");
    this.buf = "";
    this.phase = "features1";
    const sock = net.createConnection({ host: this.opts.host, port: this.opts.port });
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.setKeepAlive(true, 30_000);
    sock.setTimeout(30_000, () => {
      if (this.phase !== "online") sock.destroy(new Error("timeout"));
    });
    sock.on("connect", () => this.openStream());
    sock.on("data", (d: string) => this.onData(d));
    sock.on("error", () => {
      /* close follows */
    });
    sock.on("close", () => {
      if (this.sock !== sock) return;
      this.onClosed("disconnected");
    });
  }

  private onClosed(reason: string) {
    this.teardown(false);
    if (this.stopped) return;
    this.emit("state", "offline", reason);
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  private teardown(graceful: boolean) {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const s = this.sock;
    this.sock = null;
    if (s) {
      if (graceful && this.phase === "online") {
        try {
          s.write("<presence type='unavailable'><status>terminated PC messenger</status></presence></stream:stream>");
        } catch {
          /* ignore */
        }
      }
      s.removeAllListeners("close");
      s.destroy();
    }
    this.phase = "idle";
  }

  private onData(d: string) {
    this.lastRx = Date.now();
    this.buf += d;
    if (this.buf.length > 4_000_000) this.buf = this.buf.slice(-500_000);
    const { stanzas, rest } = splitStanzas(this.buf);
    this.buf = rest;
    for (const s of stanzas) {
      try {
        this.handle(s);
      } catch {
        /* never let a bad stanza kill the socket */
      }
    }
  }

  private handle(s: string) {
    if (s.startsWith("<stream:stream") || s.startsWith("<?xml")) return;
    if (s.startsWith("</stream:stream")) {
      this.sock?.destroy();
      return;
    }
    if (s.startsWith("<stream:error")) {
      this.sock?.destroy(new Error("stream error"));
      return;
    }
    switch (this.phase) {
      case "features1":
        if (s.startsWith("<stream:features")) {
          if (!s.includes("PLAIN")) {
            this.sock?.destroy(new Error("PLAIN not offered"));
            return;
          }
          const tok = Buffer.from(`\0${this.opts.username}\0${this.opts.password}`, "utf8").toString("base64");
          this.phase = "auth";
          this.write(`<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>${tok}</auth>`);
        }
        return;
      case "auth":
        if (s.startsWith("<success")) {
          this.phase = "features2";
          this.openStream();
        } else if (s.startsWith("<failure")) {
          this.stopped = true; // wrong key — don't hammer the server
          this.emit("state", "offline", "XMPP 인증 실패");
          this.teardown(false);
        }
        return;
      case "features2":
        if (s.startsWith("<stream:features")) {
          this.phase = "bind";
          this.write(
            `<iq type='set' id='bind1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><resource>${this.opts.resource}</resource></bind></iq>`
          );
        }
        return;
      case "bind":
        if (s.startsWith("<iq") && s.includes("bind1")) {
          if (!s.includes("<jid>")) {
            this.sock?.destroy(new Error("bind failed"));
            return;
          }
          this.phase = "session";
          this.write("<iq type='set' id='sess1'><session xmlns='urn:ietf:params:xml:ns:xmpp-session'/></iq>");
        }
        return;
      case "session":
        if (s.startsWith("<iq") && s.includes("sess1")) {
          this.phase = "online";
          this.backoff = 1000;
          this.sock?.setTimeout(0);
          this.write(presenceStanza(this.status as "online:on" | "away:on"));
          // XEP-0280: also receive copies of chats routed to / sent from other resources (official app)
          this.write("<iq type='set' id='carbons1'><enable xmlns='urn:xmpp:carbons:2'/></iq>");
          this.startPing();
          this.emit("state", "online");
        }
        return;
      case "online":
        this.handleOnline(s);
    }
  }

  private startPing() {
    this.lastRx = Date.now();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastRx > 150_000) {
        this.sock?.destroy(new Error("ping timeout"));
        return;
      }
      this.write(`<iq type='get' id='ping-${Date.now()}' to='${this.opts.domain}'><ping xmlns='urn:xmpp:ping'/></iq>`);
    }, 55_000);
  }

  private handleOnline(s: string) {
    handleOnlineStanza(s, { write: (x) => this.write(x), domain: this.opts.domain, emit: (e, p) => this.emit(e, p) });
  }
}

/** Online-phase stanza handling shared by the TCP and BOSH transports (iq ping/version, presence, JSON message bodies). */
export function handleOnlineStanza(s: string, ctx: { write: (x: string) => void; domain: string; emit: (event: "presence" | "body" | "botStatus", payload: any) => void }) {
  const head = s.slice(0, s.indexOf(">") + 1);
  if (s.startsWith("<iq")) {
    const type = attr(head, "type");
    const id = attr(head, "id") || "";
    const from = attr(head, "from") || ctx.domain;
    if (type === "get") {
      if (s.includes("urn:xmpp:ping")) ctx.write(`<iq type='result' id='${id}' to='${from}'/>`);
      else if (s.includes("jabber:iq:version"))
        ctx.write(
          `<iq type='result' id='${id}' to='${from}'><query xmlns='jabber:iq:version'><name>${flavorProfile().productName.replace(/[<&>]/g, "")}</name><version>1.0</version></query></iq>`
        );
      else
        ctx.write(
          `<iq type='error' id='${id}' to='${from}'><error type='cancel'><feature-not-implemented xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/></error></iq>`
        );
    }
    return;
  }
  if (s.startsWith("<presence")) {
    const from = attr(head, "from") || "";
    const [bare, resource = ""] = from.split("/");
    const local = bare.split("@")[0];
    const status = /<status>([\s\S]*?)<\/status>/.exec(s)?.[1];
    const show = /<show>([\s\S]*?)<\/show>/.exec(s)?.[1];
    const unescapedStatus = status && xmlUnescape(status);
    ctx.emit("presence", { local, resource, type: attr(head, "type"), status: unescapedStatus, show, statusText: parseStatusMessage(unescapedStatus, show) });
    return;
  }
  if (s.startsWith("<message")) {
    const bm = /<body[^>]*>([\s\S]*?)<\/body>/.exec(s);
    if (!bm) {
      const botStatus = parseBotStatus(s, xmlUnescape);
      if (botStatus) ctx.emit("botStatus", botStatus);
      return;
    }
    const inner = bm[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1");
    const text = inner === bm[1] ? xmlUnescape(inner) : inner;
    let obj: Record<string, any>;
    try {
      obj = JSON.parse(text);
    } catch {
      obj = { type: "raw", message: text };
    }
    ctx.emit("body", obj);
  }
}
