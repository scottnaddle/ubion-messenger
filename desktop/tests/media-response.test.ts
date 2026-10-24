import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMediaResponse, chatFileMediaPath, parseMediaRequest, sniffMediaType } from "../electron/core/media-response";

function ftyp(): Uint8Array {
  const data = new Uint8Array(16);
  data.set([0, 0, 0, 16], 0);
  data.set([102, 116, 121, 112], 4); // ftyp
  return data;
}

function freeThenFtyp(): Uint8Array {
  const data = new Uint8Array(24);
  data.set([0, 0, 0, 8, 102, 114, 101, 101], 0); // free
  data.set([0, 0, 0, 16], 8);
  data.set([102, 116, 121, 112], 12); // ftyp
  return data;
}

describe("inline video media bytes", () => {
  it("sniffs mp4 when the server sends a generic download type", () => {
    expect(sniffMediaType(ftyp(), "application/octet-stream")).toBe("video/mp4");
    expect(sniffMediaType(ftyp(), "application/octet-stream; charset=binary")).toBe("video/mp4");
    expect(sniffMediaType(ftyp(), "application/force-download")).toBe("video/mp4");
    expect(sniffMediaType(ftyp(), "application/mp4")).toBe("video/mp4");
    expect(sniffMediaType(ftyp(), "video/mp4")).toBe("video/mp4");
    expect(sniffMediaType(freeThenFtyp(), "application/octet-stream")).toBe("video/mp4");
    expect(sniffMediaType(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0]), "application/octet-stream")).toBe("video/webm");
  });

  it("uses the filename only for generic bytes, not for an html or json body", () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sniffMediaType(junk, "application/octet-stream", "ubion_benefit_30s.mp4")).toBe("video/mp4");
    expect(sniffMediaType(junk, "", "clip.webm")).toBe("video/webm");
    const html = new TextEncoder().encode("<html>login</html>");
    const json = new TextEncoder().encode('{"code":401}');
    expect(sniffMediaType(html, "text/html", "ubion_benefit_30s.mp4")).toBe("text/html");
    expect(sniffMediaType(html, "application/octet-stream", "ubion_benefit_30s.mp4")).toBe("application/octet-stream");
    expect(sniffMediaType(json, "application/json", "a.mp4")).toBe("application/json");
    expect(sniffMediaType(json, "application/octet-stream", "a.mp4")).toBe("application/octet-stream");
  });

  it("answers a full-span Range as 200 and a real slice as 206", () => {
    const data = ftyp();
    const full = buildMediaResponse(data, "application/octet-stream", null);
    expect(full.status).toBe(200);
    expect(full.headers["content-type"]).toBe("video/mp4");
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(full.headers["content-length"]).toBe("16");
    expect(full.headers["content-range"]).toBeUndefined();

    const opened = buildMediaResponse(data, "application/octet-stream", "bytes=0-");
    expect(opened.status).toBe(200);
    expect(opened.headers["content-type"]).toBe("video/mp4");
    expect(opened.headers["content-range"]).toBeUndefined();
    expect(opened.body.byteLength).toBe(16);
    expect(opened.body.buffer.byteLength).toBe(16);

    const part = buildMediaResponse(data, "video/mp4", "bytes=4-7");
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 4-7/16");
    expect(part.headers["content-length"]).toBe(String(part.body.byteLength));
    expect([...part.body]).toEqual([102, 116, 121, 112]);
    expect(part.body.byteOffset).toBe(0);
    expect(part.body.buffer.byteLength).toBe(part.body.byteLength);

    const firstOfMulti = buildMediaResponse(data, "video/mp4", "bytes=4-7,10-12");
    expect(firstOfMulti.status).toBe(206);
    expect(firstOfMulti.headers["content-range"]).toBe("bytes 4-7/16");

    const tail = buildMediaResponse(data, "video/mp4", "bytes=-4");
    expect(tail.status).toBe(206);
    expect(tail.headers["content-range"]).toBe("bytes 12-15/16");
    expect(buildMediaResponse(data, "video/mp4", "bytes=40-50").status).toBe(416);
  });

  it("strips the renderer extension hint before the Daou path", () => {
    expect(chatFileMediaPath("v/id", 1051, "ubion_benefit_30s.mp4")).toBe("/api/chat/files/v%2Fid?messageId=1051&ubmExt=mp4");
    const parsed = parseMediaRequest("ubion-media://h" + chatFileMediaPath("crypt", 9, "mp4"));
    expect(parsed.ext).toBe("mp4");
    expect(parsed.path).toBe("/api/chat/files/crypt?messageId=9");
    expect(parsed.path).not.toContain("ubmExt");
  });

  it("lets video elements load ubion-media (img-src does not cover them)", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] || "";
    expect(csp).toMatch(/media-src[^;]*ubion-media:/);
    expect(csp).toMatch(/img-src[^;]*ubion-media:/);
  });
});
