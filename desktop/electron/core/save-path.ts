/** Chat file save-location logic (pure; fs/dialog injected so it is testable without Electron). */
import path from "node:path";

export type SaveMode = "downloads" | "saveAs" | "open";

/** Server/user supplied name → safe single path segment (no dirs, no traversal, no reserved chars). */
export function sanitizeFileName(name: string, fallback = "file"): string {
  let n = String(name ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  n = n.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = `_${n}`;
  if (n.length > 200) { const e = path.extname(n).slice(0, 20); n = n.slice(0, 200 - e.length) + e; }
  return n || fallback;
}

/** "a.pdf" exists → "a (1).pdf", "a (2).pdf", … */
export function uniquePath(p: string, exists: (p: string) => boolean): string {
  if (!exists(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 1; i < 10000; i++) {
    const c = path.join(dir, `${name} (${i})${ext}`);
    if (!exists(c)) return c;
  }
  throw new Error("저장할 파일 이름을 만들 수 없습니다");
}

/** Save-As result: re-add the original extension when the user deleted it; sanitize the basename. */
export function ensureExt(chosen: string, original: string): string {
  const dir = path.dirname(chosen);
  let base = sanitizeFileName(path.basename(chosen), sanitizeFileName(original));
  const oext = path.extname(sanitizeFileName(original));
  if (oext && !path.extname(base)) base += oext;
  return path.join(dir, base);
}

export type SaveCtx = {
  mode: SaveMode; name: string; downloadDir: string; askEveryTime: boolean; lastSaveDir?: string; defaultDownloads: string;
};
export type SaveDeps = {
  exists: (p: string) => boolean;
  showSaveDialog: (defaultPath: string) => Promise<string | null>;
};

/** Decide the target path (null = user cancelled). "저장" with askEveryTime behaves like Save As. */
export async function resolveSaveTarget(c: SaveCtx, deps: SaveDeps): Promise<{ target: string; dir: string } | null> {
  const name = sanitizeFileName(c.name);
  const dl = c.downloadDir || c.defaultDownloads;
  const dialog = c.mode === "saveAs" || (c.mode === "downloads" && c.askEveryTime);
  if (!dialog) {
    const target = uniquePath(path.join(dl, name), deps.exists);
    return { target, dir: dl };
  }
  const r = await deps.showSaveDialog(path.join(c.lastSaveDir || dl, name));
  if (!r) return null;
  const target = ensureExt(r, name);
  return { target, dir: path.dirname(target) };
}
