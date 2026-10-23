import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureExt, resolveSaveTarget, sanitizeFileName, uniquePath } from "../electron/core/save-path";

const fakeFs = (files: string[]) => { const set = new Set(files); return (p: string) => set.has(p); };
const DL = path.join("/home/u", "Downloads");
const base = { name: "보고서.pdf", downloadDir: "", askEveryTime: false, defaultDownloads: DL };

describe("sanitizeFileName", () => {
  it("strips directories / traversal / reserved chars", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("..\\..\\win.ini")).toBe("win.ini");
    expect(sanitizeFileName('a<b>:c"|?*.txt')).toBe("a_b__c____.txt");
    expect(sanitizeFileName("..")).toBe("file");
    expect(sanitizeFileName("  .hidden. ")).toBe("hidden");
    expect(sanitizeFileName("CON.txt")).toBe("_CON.txt");
    expect(sanitizeFileName("x\u0000y.png")).toBe("x_y.png");
    const long = sanitizeFileName("a".repeat(300) + ".docx");
    expect(long.length).toBe(200); expect(long.endsWith(".docx")).toBe(true);
  });
});

describe("uniquePath", () => {
  it("auto-suffixes ' (1)', ' (2)'", () => {
    const p = path.join(DL, "a.pdf");
    expect(uniquePath(p, fakeFs([]))).toBe(p);
    expect(uniquePath(p, fakeFs([p]))).toBe(path.join(DL, "a (1).pdf"));
    expect(uniquePath(p, fakeFs([p, path.join(DL, "a (1).pdf")]))).toBe(path.join(DL, "a (2).pdf"));
    expect(uniquePath(path.join(DL, "README"), fakeFs([path.join(DL, "README")]))).toBe(path.join(DL, "README (1)"));
  });
});

describe("ensureExt", () => {
  it("re-adds the original extension only when missing", () => {
    expect(ensureExt("/x/새이름", "보고서.pdf")).toBe(path.join("/x", "새이름.pdf"));
    expect(ensureExt("/x/새이름.docx", "보고서.pdf")).toBe(path.join("/x", "새이름.docx"));
    expect(ensureExt("/x/noext", "README")).toBe(path.join("/x", "noext"));
  });
});

describe("resolveSaveTarget (fake fs + fake dialog)", () => {
  it("저장 → default Downloads, collision suffix, no dialog", async () => {
    const showSaveDialog = vi.fn();
    const r = await resolveSaveTarget({ ...base, mode: "downloads" }, { exists: fakeFs([path.join(DL, "보고서.pdf")]), showSaveDialog });
    expect(r).toEqual({ target: path.join(DL, "보고서 (1).pdf"), dir: DL });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });
  it("저장 → configured download folder", async () => {
    const r = await resolveSaveTarget({ ...base, mode: "downloads", downloadDir: "/data/받은파일" }, { exists: fakeFs([]), showSaveDialog: vi.fn() });
    expect(r?.target).toBe(path.join("/data/받은파일", "보고서.pdf"));
  });
  it("저장 with '매번 저장 위치 묻기' → dialog", async () => {
    const showSaveDialog = vi.fn(async () => "/d/x.pdf");
    const r = await resolveSaveTarget({ ...base, mode: "downloads", askEveryTime: true }, { exists: fakeFs([]), showSaveDialog });
    expect(showSaveDialog).toHaveBeenCalledWith(path.join(DL, "보고서.pdf"));
    expect(r).toEqual({ target: path.join("/d", "x.pdf"), dir: "/d" });
  });
  it("다른 이름으로 저장 → default = last folder + sanitized original name; rename keeps ext", async () => {
    const showSaveDialog = vi.fn(async () => "/Users/u/Desktop/새 이름");
    const r = await resolveSaveTarget({ ...base, name: "../../evil/보고서.pdf", mode: "saveAs", lastSaveDir: "/Users/u/Docs" }, { exists: fakeFs([]), showSaveDialog });
    expect(showSaveDialog).toHaveBeenCalledWith(path.join("/Users/u/Docs", "보고서.pdf"));
    expect(r).toEqual({ target: path.join("/Users/u/Desktop", "새 이름.pdf"), dir: "/Users/u/Desktop" });
  });
  it("cancel → null", async () => {
    expect(await resolveSaveTarget({ ...base, mode: "saveAs" }, { exists: fakeFs([]), showSaveDialog: async () => null })).toBeNull();
  });
  it("dialog-chosen path's basename is sanitized too", async () => {
    const r = await resolveSaveTarget({ ...base, mode: "saveAs" }, { exists: fakeFs([]), showSaveDialog: async () => "/d/a:b.pdf" });
    expect(r?.target).toBe(path.join("/d", "a_b.pdf"));
  });
});
