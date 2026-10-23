import { describe, expect, it } from "vitest";
import {
  CAPTURE_MIN_SIZE, CAPTURE_PERMISSION_ERROR, captureFileName, captureOverlayHtml, captureOverlayUrl,
  capturePermissionError, captureScale, captureThumbnailSize, normalizeCropRect, pickScreenSource,
} from "../electron/core/capture";

describe("captureFileName", () => {
  it("formats local time as do-messenger_screenshot_YYYYMMDDHHmmss.png", () => {
    expect(captureFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe("do-messenger_screenshot_20260102030405.png");
    expect(captureFileName(new Date(2026, 11, 31, 23, 59, 59))).toBe("do-messenger_screenshot_20261231235959.png");
  });
  it("defaults to now", () => {
    expect(captureFileName()).toMatch(/^do-messenger_screenshot_\d{14}\.png$/);
  });
});

describe("normalizeCropRect", () => {
  const img = { width: 2880, height: 1800 };
  it("scales DIP to image pixels", () => {
    expect(normalizeCropRect({ x: 10, y: 20, width: 100, height: 50 }, img, 2)).toEqual({ x: 20, y: 40, width: 200, height: 100 });
  });
  it("normalizes negative drags (up/left)", () => {
    expect(normalizeCropRect({ x: 110, y: 70, width: -100, height: -50 }, img, 2)).toEqual({ x: 20, y: 40, width: 200, height: 100 });
  });
  it("expands fractional scale outward to whole pixels", () => {
    expect(normalizeCropRect({ x: 10.3, y: 10.3, width: 10, height: 10 }, { width: 1000, height: 1000 }, 1.25))
      .toEqual({ x: 12, y: 12, width: 14, height: 14 });
  });
  it("supports separate x/y scale", () => {
    expect(normalizeCropRect({ x: 10, y: 10, width: 10, height: 10 }, img, { x: 2, y: 1.5 })).toEqual({ x: 20, y: 15, width: 20, height: 15 });
  });
  it("clamps to the image", () => {
    expect(normalizeCropRect({ x: -50, y: 1700, width: 200, height: 500 }, { width: 1440, height: 1800 }, 1))
      .toEqual({ x: 0, y: 1700, width: 150, height: 100 });
  });
  it("rejects tiny, empty, out-of-bounds and invalid selections", () => {
    expect(normalizeCropRect({ x: 0, y: 0, width: CAPTURE_MIN_SIZE - 1, height: 100 }, img, 2)).toBeNull();
    expect(normalizeCropRect({ x: 5000, y: 0, width: 100, height: 100 }, img, 1)).toBeNull();
    expect(normalizeCropRect(null, img, 2)).toBeNull();
    expect(normalizeCropRect({ x: "a", y: 0, width: 10, height: 10 }, img, 2)).toBeNull();
    expect(normalizeCropRect({ x: 0, y: 0, width: 10, height: 10 }, img, 0)).toBeNull();
    expect(normalizeCropRect({ x: 0, y: 0, width: Infinity, height: 10 }, img, 1)).toBeNull();
  });
});

describe("captureScale / captureThumbnailSize", () => {
  it("derives px-per-DIP from the real thumbnail size", () => {
    expect(captureScale({ width: 2880, height: 1800 }, { width: 1440, height: 900 })).toEqual({ x: 2, y: 2 });
    expect(captureScale({ width: 0, height: 0 }, { width: 1440, height: 900 }, 1.5)).toEqual({ x: 1.5, y: 1.5 });
  });
  it("requests the display at native resolution", () => {
    expect(captureThumbnailSize({ width: 1440, height: 900 }, 2)).toEqual({ width: 2880, height: 1800 });
    expect(captureThumbnailSize({ width: 1536, height: 864 }, 1.25)).toEqual({ width: 1920, height: 1080 });
    expect(captureThumbnailSize({ width: 800, height: 600 }, NaN)).toEqual({ width: 800, height: 600 });
  });
});

describe("capturePermissionError", () => {
  it("requires granted screen access on macOS only", () => {
    expect(capturePermissionError("darwin", "granted")).toBeNull();
    expect(capturePermissionError("darwin", "denied")).toBe(CAPTURE_PERMISSION_ERROR);
    expect(capturePermissionError("darwin", "not-determined")).toBe(CAPTURE_PERMISSION_ERROR);
    expect(capturePermissionError("darwin")).toBe(CAPTURE_PERMISSION_ERROR);
    expect(capturePermissionError("win32")).toBeNull();
    expect(capturePermissionError("linux", "denied")).toBeNull();
    expect(CAPTURE_PERMISSION_ERROR).toContain("화면 기록");
  });
});

describe("pickScreenSource", () => {
  it("matches the display id, falls back to a single source", () => {
    const a = { id: "screen:1", display_id: "1" }, b = { id: "screen:2", display_id: "2" };
    expect(pickScreenSource([a, b], 2)).toBe(b);
    expect(pickScreenSource([a, b], 3)).toBeNull();
    expect(pickScreenSource([{ id: "screen:0", display_id: "" }], 9)).toEqual({ id: "screen:0", display_id: "" });
    expect(pickScreenSource([], 1)).toBeNull();
  });
});

describe("overlay page", () => {
  it("is locked down by CSP and supports Esc cancel", () => {
    const html = captureOverlayHtml();
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("img-src data:");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('"Escape"');
    expect(html).toContain("finish(null)");
    expect(captureOverlayUrl().startsWith("data:text/html;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(captureOverlayUrl().slice("data:text/html;charset=utf-8,".length))).toBe(html);
  });
});
