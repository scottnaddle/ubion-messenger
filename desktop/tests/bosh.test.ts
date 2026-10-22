import { describe, expect, it } from "vitest";
import { BoshClient, parseBoshBody } from "../electron/core/bosh";

const W = (inner: string, attrs = "") => `<body xmlns='http://jabber.org/protocol/httpbind'${attrs}>${inner}</body>`;
const FEAT1 = `<stream:features><mechanisms xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><mechanism>PLAIN</mechanism></mechanisms></stream:features>`;
const FEAT2 = `<stream:features><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"/></stream:features>`;

/** Scripted BOSH server: answers handshake, then serves queued push stanzas to long-polls. */
function server(opts: { authFail?: boolean } = {}) {
  const sent: string[] = [];
  const push: string[] = [];
  let waiting: Array<(v: { status: number; text: string }) => void> = [];
  const post = async (_url: string, body: string) => {
    sent.push(body);
    if (body.includes("hold='1'")) return { status: 200, text: W(FEAT1, ` sid='S1' requests='2' wait='5'`) };
    if (body.includes("<auth")) return { status: 200, text: W(opts.authFail ? `<failure xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><not-authorized/></failure>` : `<success xmlns="urn:ietf:params:xml:ns:xmpp-sasl"/>`) };
    if (body.includes("xmpp:restart")) return { status: 200, text: W(FEAT2) };
    if (body.includes("bind1")) return { status: 200, text: W(`<iq type="result" id="bind1"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><jid>312@d/r</jid></bind></iq>`) };
    if (body.includes("sess1")) return { status: 200, text: W(`<iq type="result" id="sess1"/>`) };
    if (body.includes("type='terminate'")) return { status: 200, text: W("", ` type='terminate'`) };
    if (/>[^<]*<\/body>$/.test(body) && body.replace(/^<body[^>]*>|<\/body>$/g, "") === "") {
      if (push.length) return { status: 200, text: W(push.splice(0).join("")) };
      return new Promise<{ status: number; text: string }>((r) => waiting.push(r));
    }
    return { status: 200, text: W("") };
  };
  const deliver = (s: string) => {
    const w = waiting.shift();
    if (w) w({ status: 200, text: W(s) });
    else push.push(s);
  };
  const releaseAll = () => { waiting.forEach((w) => w({ status: 200, text: W("") })); waiting = []; };
  return { post, sent, deliver, releaseAll };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("BOSH transport", () => {
  it("parseBoshBody", () => {
    expect(parseBoshBody(`<body sid="abc" requests="2" xmlns="x"/>`)).toEqual({ attrs: { sid: "abc", requests: "2", xmlns: "x" }, stanzas: [] });
    const r = parseBoshBody(W(`<presence from="1@d/r"/><message><body>{}</body></message>`, ` ack='1'`));
    expect(r.stanzas).toHaveLength(2);
    expect(() => parseBoshBody("<html>")).toThrow();
  });

  it("handshake → online; presence+carbons sent; push messages/presence/ping handled; password never in non-auth bodies", async () => {
    const s = server();
    const c = new BoshClient({ url: "https://h/http-bind/", domain: "d", username: "312", password: "SECRETKEY1", resource: "go_pc_312_1_ubion", post: s.post });
    const states: string[] = []; const bodies: any[] = []; const pres: any[] = [];
    c.on("state", (x) => states.push(x)); c.on("body", (b) => bodies.push(b)); c.on("presence", (p) => pres.push(p));
    c.start();
    for (let i = 0; i < 20 && !c.online; i++) await tick();
    expect(c.online).toBe(true);
    expect(states).toEqual(["connecting", "online"]);
    await tick();
    expect(s.sent.some((b) => b.includes("<presence><status>online:on</status></presence>") && b.includes("urn:xmpp:carbons:2"))).toBe(true);
    // rids strictly increase
    const rids = s.sent.map((b) => Number(/rid='(\d+)'/.exec(b)![1]));
    expect(rids.every((r, i) => i === 0 || r === rids[i - 1] + 1)).toBe(true);
    s.deliver(`<message from="5@d/x"><body>{"type":"message","messageId":9}</body></message><presence from="5@d/go_pc"><status>online:on</status></presence><iq type="get" id="p1" from="d"><ping xmlns="urn:xmpp:ping"/></iq>`);
    for (let i = 0; i < 10; i++) await tick();
    expect(bodies).toEqual([{ type: "message", messageId: 9 }]);
    expect(pres[0]).toMatchObject({ local: "5", resource: "go_pc", status: "online:on" });
    expect(s.sent.some((b) => b.includes("<iq type='result' id='p1' to='d'/>"))).toBe(true);
    const b64 = Buffer.from("\u0000312\u0000SECRETKEY1").toString("base64");
    expect(s.sent.filter((b) => b.includes(b64))).toHaveLength(1);
    expect(s.sent.filter((b) => b.includes("SECRETKEY1"))).toHaveLength(0);
    c.setStatus("away:on");
    for (let i = 0; i < 5; i++) await tick();
    expect(s.sent.some((b) => b.includes("away:on"))).toBe(true);
    c.stop();
    expect(s.sent.at(-1)).toContain("type='terminate'");
    s.releaseAll();
  });

  it("auth failure stops without retry", async () => {
    const s = server({ authFail: true });
    const c = new BoshClient({ url: "u", domain: "d", username: "1", password: "x", resource: "r", post: s.post });
    const st: Array<[string, string?]> = [];
    c.on("state", (a, b) => st.push([a, b]));
    c.start();
    for (let i = 0; i < 10; i++) await tick();
    expect(st.at(-1)).toEqual(["offline", "XMPP 인증 실패"]);
    const n = s.sent.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(s.sent.length).toBe(n);
  });

  it("HTTP error → offline + reconnect with backoff, counts failures before online", async () => {
    let n = 0;
    const c = new BoshClient({ url: "u", domain: "d", username: "1", password: "x", resource: "r", post: async () => { n++; return { status: 503, text: "" }; } });
    const st: string[] = [];
    c.on("state", (a) => st.push(a));
    c.start();
    await new Promise((r) => setTimeout(r, 1200));
    expect(st.slice(0, 2)).toEqual(["connecting", "offline"]);
    expect(c.failuresBeforeOnline).toBeGreaterThanOrEqual(2);
    expect(n).toBeGreaterThanOrEqual(2);
    c.stop();
  });
});
