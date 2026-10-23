import { describe, expect, it } from "vitest";
import { guessMime } from "../electron/core/mime";

describe("guessMime", () => {
  it("recognises image formats including bmp, svg and heic", () => {
    expect(guessMime("photo.PNG")).toBe("image/png");
    expect(guessMime("photo.jpg")).toBe("image/jpeg");
    expect(guessMime("photo.jpeg")).toBe("image/jpeg");
    expect(guessMime("photo.gif")).toBe("image/gif");
    expect(guessMime("photo.webp")).toBe("image/webp");
    expect(guessMime("photo.bmp")).toBe("image/bmp");
    expect(guessMime("drawing.svg")).toBe("image/svg+xml");
    expect(guessMime("photo.heic")).toBe("image/heic");
    expect(guessMime("photo.heif")).toBe("image/heif");
  });

  it("keeps existing document types and falls back to binary", () => {
    expect(guessMime("doc.pdf")).toBe("application/pdf");
    expect(guessMime("notes.txt")).toBe("text/plain");
    expect(guessMime("bundle.zip")).toBe("application/zip");
    expect(guessMime("archive.tar")).toBe("application/octet-stream");
    expect(guessMime("noext")).toBe("application/octet-stream");
  });
});
