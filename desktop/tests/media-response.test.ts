import { describe, expect, it } from "vitest";
import { buildMediaResponse, sniffMediaType } from "../electron/core/media-response";

function ftyp(): Uint8Array {
  const data = new Uint8Array(16);
  data.set([0, 0, 0, 16], 0);
  data.set([102, 116, 121, 112], 4); // ftyp
  return data;
}

describe("inline video media bytes", () => {
  it("sniffs mp4 when the server sends octet-stream", () => {
    expect(sniffMediaType(ftyp(), "application/octet-stream")).toBe("video/mp4");
    expect(sniffMediaType(ftyp(), "video/mp4")).toBe("video/mp4");
    expect(sniffMediaType(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0]), "application/octet-stream")).toBe("video/webm");
  });

  it("returns a byte range so the player can scrub", () => {
    const data = ftyp();
    const full = buildMediaResponse(data, "application/octet-stream", null);
    expect(full.status).toBe(200);
    expect(full.headers["content-type"]).toBe("video/mp4");
    expect(full.headers["accept-ranges"]).toBe("bytes");
    const part = buildMediaResponse(data, "video/mp4", "bytes=4-7");
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 4-7/16");
    expect([...part.body]).toEqual([102, 116, 121, 112]);
    expect(buildMediaResponse(data, "video/mp4", "bytes=40-50").status).toBe(416);
  });
});
