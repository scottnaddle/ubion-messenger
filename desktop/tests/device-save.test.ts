import { describe, expect, it, vi } from "vitest";
import { isShareCancel, safeDownloadName, saveDownloadedFile, uniqueFileName, type DeviceFiles, type SavedDeviceFile } from "../src/mobile/device-save";

function device(over: Partial<DeviceFiles> = {}): DeviceFiles {
  const saved: SavedDeviceFile = { uri: "file:///tmp/a.mp4", displayPath: "Files/UBION/a.mp4", name: "a.mp4", shareToKeep: false };
  return {
    write: vi.fn(async () => saved),
    share: vi.fn(async () => "shared" as const),
    shareSaved: vi.fn(async () => undefined),
    ...over,
  };
}

describe("device save", () => {
  it("keeps a documents copy without opening the share sheet", async () => {
    const files = device();
    const path = await saveDownloadedFile({ name: "a.mp4", bytes: new Uint8Array([1]), mime: "video/mp4", mode: "downloads" }, files);
    expect(path).toBe("Files/UBION/a.mp4");
    expect(files.share).not.toHaveBeenCalled();
  });

  it("returns null when Save As is dismissed", async () => {
    const files = device({ share: vi.fn(async () => "cancelled") });
    expect(await saveDownloadedFile({ name: "a.mp4", bytes: new Uint8Array([1]), mime: "video/mp4", mode: "saveAs" }, files)).toBeNull();
  });

  it("opens the sheet when the only copy is in cache", async () => {
    const files = device({
      write: vi.fn(async () => ({ uri: "file:///cache/a.mp4", displayPath: "Cache/UBION/a.mp4", name: "a.mp4", shareToKeep: true })),
    });
    expect(await saveDownloadedFile({ name: "a.mp4", bytes: new Uint8Array([1]), mime: "video/mp4", mode: "downloads" }, files)).toBe("Cache/UBION/a.mp4");
    expect(files.share).toHaveBeenCalled();
  });

  it("rejects an unknown mode and sanitizes names", () => {
    expect(safeDownloadName("../a/b:c.mp4")).toBe("b_c.mp4");
    expect(uniqueFileName("a.mp4", new Set(["a.mp4"]))).toBe("a (1).mp4");
    expect(isShareCancel(new Error("Share canceled"))).toBe(true);
    return expect(saveDownloadedFile({ name: "a", bytes: new Uint8Array(), mime: "", mode: "nope" }, device())).rejects.toThrow("invalid save mode");
  });
});
