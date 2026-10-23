import { describe, expect, it } from "vitest";
import {
  addFiles, addFilesWithReport, dedupeFiles, executeSendPlan, fileKey, folderSkipMessage,
  formatSize, isImageFile, MAX_FILE_SIZE, mergeStaged, removeFile, sendPlan, splitDroppedFiles,
  validateFile,
} from "../src/attach-tray";

const f = (name: string, size: number, lastModified = 0) => ({ name, size, lastModified });

describe("attach tray", () => {
  it("adds multiple files in order and de-dupes by name+size+lastModified", () => {
    const a = f("a.png", 10, 1);
    const b = f("b.pdf", 20, 2);
    const tray = addFiles([], [a, b, a]);
    expect(tray.map((x) => x.name)).toEqual(["a.png", "b.pdf"]);
    expect(addFiles(tray, [b])).toHaveLength(2);
    expect(dedupeFiles([a, b, a])).toEqual([a, b]);
    expect(fileKey(a)).not.toBe(fileKey(f("a.png", 10, 3)));
  });

  it("removes by file, id, key or name", () => {
    const tray = addFiles([], [f("a.png", 10, 1), f("b.pdf", 20, 2), f("c.txt", 30, 3)]);
    expect(removeFile(tray, tray[0]).map((x) => x.name)).toEqual(["b.pdf", "c.txt"]);
    expect(removeFile(tray, tray[1].id).map((x) => x.name)).toEqual(["a.png", "c.txt"]);
    expect(removeFile(tray, "c.txt").map((x) => x.name)).toEqual(["a.png", "b.pdf"]);
    expect(removeFile(tray, tray[2])).toHaveLength(2);
  });

  it("formats human sizes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(900)).toBe("900 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });

  it("reuses the existing upload size limit at staging time", () => {
    const big = f("big.zip", MAX_FILE_SIZE + 1);
    expect(validateFile(big)).toBe("big.zip: 300MB를 초과합니다");
    expect(validateFile(f("ok.zip", MAX_FILE_SIZE))).toBeNull();
    const report = addFilesWithReport([], [big, f("ok.zip", 1)]);
    expect(report.errors).toEqual(["big.zip: 300MB를 초과합니다"]);
    expect(report.rejected[0].file).toBe(big);
    expect(report.files.map((x) => x.name)).toEqual(["ok.zip"]);
  });

  it("plans files in order and text last only when non-empty", () => {
    const files = [f("a.png", 10, 1), f("b.pdf", 20, 2)];
    const plan = sendPlan(files, " 안녕하세요  ");
    expect(plan.map((s) => s.type)).toEqual(["file", "file", "text"]);
    expect(plan[0]).toEqual({ type: "file", file: files[0] });
    expect(plan[2]).toEqual({ type: "text", text: " 안녕하세요" });
    expect(sendPlan(files, "   ").map((s) => s.type)).toEqual(["file", "file"]);
    expect(sendPlan([], "hi")).toEqual([{ type: "text", text: "hi" }]);
    expect(sendPlan([], " ")).toEqual([]);
  });

  it("detects image chips", () => {
    expect(isImageFile({ type: "image/png", name: "x" })).toBe(true);
    expect(isImageFile({ type: "", name: "shot.PNG" })).toBe(true);
    expect(isImageFile({ type: "application/pdf", name: "x.pdf" })).toBe(false);
  });

  it("merges failed staged files back without losing previews or duplicating", () => {
    const a = { ...addFiles([], [f("a.png", 10, 1)])[0], previewUrl: "blob:a" };
    const b = addFiles([], [f("b.pdf", 20, 2)])[0];
    expect(mergeStaged([a], [b, a])).toEqual([a, b]);
    expect(mergeStaged([a], [a])[0].previewUrl).toBe("blob:a");
  });

  it("filters dropped folders out of file candidates", () => {
    const entries = [
      { name: "a.png", isDirectory: false },
      { name: "folder", isDirectory: true },
      { name: "b.pdf" },
    ];
    const split = splitDroppedFiles(entries);
    expect(split.files.map((x) => x.name)).toEqual(["a.png", "b.pdf"]);
    expect(split.folders.map((x) => x.name)).toEqual(["folder"]);
    expect(folderSkipMessage(split.folders.map((x) => x.name))).toBe("폴더는 첨부할 수 없습니다: folder");
    expect(folderSkipMessage([])).toBe("");
  });

  it("sends files in order and skips text when any file fails", async () => {
    const calls: string[] = [];
    const outcome = await executeSendPlan(
      sendPlan([f("a.png", 10, 1), f("b.pdf", 20, 2)], " hello  "),
      async (file) => {
        calls.push(file.name);
        return file.name === "a.png";
      },
      async (text) => { calls.push(`text:${text}`); },
    );
    expect(calls).toEqual(["a.png", "b.pdf"]);
    expect(outcome.succeeded.map((x) => x.name)).toEqual(["a.png"]);
    expect(outcome.failed.map((x) => x.name)).toEqual(["b.pdf"]);
    expect(outcome.textSent).toBe(false);
  });

  it("sends text after all files succeed and reports per-file completion", async () => {
    const calls: string[] = [];
    const done: boolean[] = [];
    const outcome = await executeSendPlan(
      sendPlan([f("a.png", 10, 1), f("b.pdf", 20, 2)], "hi"),
      async () => true,
      async (text) => { calls.push(`text:${text}`); },
      (_file, ok) => done.push(ok),
    );
    expect(calls).toEqual(["text:hi"]);
    expect(outcome.succeeded).toHaveLength(2);
    expect(outcome.failed).toHaveLength(0);
    expect(outcome.textSent).toBe(true);
    expect(done).toEqual([true, true]);
  });

  it("treats a throwing file sender as a failure", async () => {
    const outcome = await executeSendPlan(
      sendPlan([f("a.png", 10, 1)], "hi"),
      async () => { throw new Error("boom"); },
      async () => { throw new Error("text should not send"); },
    );
    expect(outcome.failed.map((x) => x.name)).toEqual(["a.png"]);
    expect(outcome.textSent).toBe(false);
  });
});
