import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { attachKind, durationLabel, expiryLabel, fileIcon, isExpired, normalizeAttach, parseExpiry, sizeLabel } from "../electron/core/attach";
import { checkTarget, fetchLinkPreview, isPrivateIp, parseOpenGraph, PreviewCache } from "../electron/core/link-preview";
import { MediaCache } from "../electron/core/media-cache";
import { normalizeRestMessage } from "../electron/core/daou-client";
import { routeXmppBody } from "../electron/core/messenger";

describe("attach normalize", () => {
  it("parses the REST model with expiry and DaouOffice labels", () => {
    const m = normalizeRestMessage({ messageId: 9, messageType: "SENDFILE", message: "보고서.pdf",
      chatMessageAttachFileModel: { cryptId: "abc", name: "보고서.pdf", extention: "pdf", size: 80 * 1024 * 1024, expireDate: "2027-10-23" } });
    const a = m.attach!;
    expect(a.cryptId).toBe("abc");
    expect(expiryLabel(a)).toBe("유효기간 : ~ 2027.10.23");
    expect(sizeLabel(a.size)).toBe("80MB");
    expect(attachKind(a)).toBe("file");
    expect(fileIcon(a.name, a.extention).label).toBe("PDF");
    expect(isExpired(a, Date.parse("2027-10-23T12:00:00+09:00"))).toBe(false);
    expect(isExpired(a, Date.parse("2027-10-24T00:00:01+09:00"))).toBe(true);
  });
  it("accepts alternate spellings, epoch ms, expired flag", () => {
    const a = normalizeAttach({ cryptId: 5, fileName: "clip.MOV", size: "1234", expiredAt: 1700000000000, duration: 75 })!;
    expect(a.name).toBe("clip.MOV");
    expect(a.extention).toBe("mov");
    expect(attachKind(a)).toBe("video");
    expect(durationLabel(a.duration)).toBe("1:15");
    expect(isExpired(a)).toBe(true);
    expect(isExpired(normalizeAttach({ cryptId: "x", name: "a", expired: true })!)).toBe(true);
    expect(normalizeAttach({ name: "no id" })).toBeUndefined();
    expect(parseExpiry("20271023")).toBe(new Date("2027-10-23T23:59:59+09:00").toISOString());
  });
  it("image kind by flag or extension; sizes", () => {
    expect(attachKind({ cryptId: "1", name: "x.bin", imageFile: true })).toBe("image");
    expect(attachKind({ cryptId: "1", name: "x.JPG" })).toBe("image");
    expect(sizeLabel(512)).toBe("512B");
    expect(sizeLabel(1.7 * 1024 * 1024)).toBe("1.7MB");
    expect(sizeLabel(2048)).toBe("2KB");
  });
  it("XMPP chat payload keeps attach", () => {
    const r: any = routeXmppBody({ type: "message", subtype: "single", from: { userSeq: 7, userName: "x" }, toSeq: 2, messageId: 11,
      message: "v.mp4", chatMessageAttachFileModel: { cryptId: "cid", name: "v.mp4", size: 10, thumbMid: "/t.jpg" } }, 2);
    expect(r.msg.messageType).toBe("SENDFILE");
    expect(r.msg.attach).toMatchObject({ cryptId: "cid", thumbMid: "/t.jpg" });
    expect(attachKind(r.msg.attach)).toBe("video");
  });
});

describe("link preview", () => {
  it("parses OpenGraph with fallbacks and entity decoding", () => {
    const p = parseOpenGraph(`<html><head><title>Fallback</title>
      <meta property="og:title" content="Hello &amp; 안녕"><meta name="description" content="desc">
      <meta property="og:image" content="/img.png"><meta property="og:site_name" content="Example"></head>`, "https://ex.com/a/b");
    expect(p).toMatchObject({ title: "Hello & 안녕", description: "desc", siteName: "Example", image: "https://ex.com/img.png" });
    expect(parseOpenGraph("<title>T</title>", "https://x.org/").siteName).toBe("x.org");
    expect(parseOpenGraph('<meta property="og:image" content="javascript:alert(1)"><title>t</title>', "https://x.org/").image).toBeUndefined();
  });
  it("blocks private/LAN IPs, non-http schemes; allows company host", async () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "192.168.0.5", "172.16.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1", "100.64.0.1"]) expect(isPrivateIp(ip)).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    await expect(checkTarget("file:///etc/passwd")).rejects.toThrow();
    await expect(checkTarget("http://169.254.169.254/latest")).rejects.toThrow(/private/);
    await expect(checkTarget("https://evil.test/", { lookup: async () => ["10.0.0.7"] })).rejects.toThrow(/private/);
    const ok = await checkTarget("https://coco.ubion.co.kr/app/x", { companyBase: "https://coco.ubion.co.kr", lookup: async () => ["10.0.0.7"] });
    expect(ok.ip).toBe("10.0.0.7");
    const card = await fetchLinkPreview("https://coco.ubion.co.kr/app/board/1", { companyBase: "https://coco.ubion.co.kr", lookup: async () => ["10.0.0.7"] });
    expect(card?.internal).toBe(true);
  });
  it("fetches from a loopback server only when it is the company host, caps size, no cookies", async () => {
    let cookie: string | undefined;
    const srv = http.createServer((req, res) => {
      cookie = req.headers.cookie;
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (req.url === "/big") { res.write("<title>Big</title>"); res.end("x".repeat(3 * 1024 * 1024)); return; }
      if (req.url === "/slow") return; // never answers
      res.end('<meta property="og:title" content="Local">');
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    await expect(fetchLinkPreview(base + "/")).rejects.toThrow(/private/);
    // simulate a public host that resolves to loopback in-test via lookup override + treat as public by stubbing isPrivate: use companyBase mismatch → still blocked
    await expect(fetchLinkPreview(`http://pub.test:${port}/`, { lookup: async () => ["127.0.0.1"] })).rejects.toThrow(/private/);
    const t = { allowPrivate: true, lookup: async () => ["127.0.0.1"] };
    expect((await fetchLinkPreview(`http://pub.test:${port}/`, t))?.title).toBe("Local");
    expect((await fetchLinkPreview(`http://pub.test:${port}/big`, t))?.title).toBe("Big");
    const t0 = Date.now();
    await expect(fetchLinkPreview(`http://pub.test:${port}/slow`, { ...t, timeoutMs: 300 })).rejects.toThrow(/timeout/);
    expect(Date.now() - t0).toBeLessThan(2000);
    srv.closeAllConnections(); srv.close();
    expect(cookie).toBeUndefined();
  });
  it("cache dedupes and expires failures", async () => {
    const c = new PreviewCache(2, 1000, 100);
    let n = 0;
    const load = async () => (n++, { url: "u", title: "t" });
    await Promise.all([c.get("u", load, 0), c.get("u", load, 0)]);
    expect(n).toBe(1);
    await c.get("u", load, 2000);
    expect(n).toBe(2);
    await c.get("a", load); await c.get("b", load);
    expect(c.size).toBe(2);
  });
});

describe("media cache", () => {
  it("LRU by bytes, skips large items", () => {
    const c = new MediaCache(10, 6);
    const e = (n: number) => ({ data: Buffer.alloc(n), contentType: "image/png" });
    c.set("a", e(4)); c.set("b", e(4)); c.get("a"); c.set("c", e(4));
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBeDefined();
    c.set("big", e(7));
    expect(c.get("big")).toBeUndefined();
  });
});
