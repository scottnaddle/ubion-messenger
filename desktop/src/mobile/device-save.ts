/**
 * Chat-file save on device. Pure: the Capacitor Filesystem/Share calls are injected
 * so tests never touch a phone. "저장" keeps the file; "다른 이름으로 저장" and
 * "기본 앱으로 열기" hand it to the system share sheet (Photos, Files, another app).
 */

export type MobileSaveMode = "downloads" | "saveAs" | "open";

export type SavedDeviceFile = {
  uri: string;
  /** User-facing location, e.g. "Files/UBION/clip.mp4". */
  displayPath: string;
  name: string;
  /** True when the only copy is in a cache dir the share sheet must move. */
  shareToKeep: boolean;
};

export type DeviceFiles = {
  write(name: string, bytes: Uint8Array, mime: string): Promise<SavedDeviceFile>;
  share(file: SavedDeviceFile): Promise<"shared" | "cancelled">;
  /** Re-open the share sheet for a path this session already wrote. */
  shareSaved(displayPath: string): Promise<void>;
};

/** Server/user name → one safe path segment. No Node `path` (mobile bundle). */
export function safeDownloadName(name: string, fallback = "file"): string {
  let n = String(name ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  n = n.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = `_${n}`;
  if (n.length > 180) {
    const dot = n.lastIndexOf(".");
    const ext = dot > 0 ? n.slice(dot).slice(0, 16) : "";
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n || fallback;
}

export function uniqueFileName(name: string, taken: ReadonlySet<string>): string {
  const safe = safeDownloadName(name);
  if (!taken.has(safe)) return safe;
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  for (let i = 1; i < 10000; i++) {
    const next = `${stem} (${i})${ext}`;
    if (!taken.has(next)) return next;
  }
  throw new Error("저장할 파일 이름을 만들 수 없습니다");
}

export function isShareCancel(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
  return /cancel|canceled|cancelled|abort/.test(m);
}

/**
 * Download is already in `bytes`. Returns null when the user dismisses the share sheet
 * on Save As / Open (same as a cancelled desktop dialog). "저장" still returns the path
 * when the file landed in Files; a cache-only copy opens the sheet because otherwise
 * the user cannot reach it.
 */
export async function saveDownloadedFile(
  opts: { name: string; bytes: Uint8Array; mime: string; mode: string },
  device: DeviceFiles,
): Promise<string | null> {
  if (opts.mode !== "downloads" && opts.mode !== "saveAs" && opts.mode !== "open") {
    throw new Error("invalid save mode");
  }
  const saved = await device.write(opts.name, opts.bytes, opts.mime || "application/octet-stream");
  const mustShare = opts.mode !== "downloads" || saved.shareToKeep;
  if (!mustShare) return saved.displayPath;
  const result = await device.share(saved);
  if (result === "cancelled") return opts.mode === "downloads" && !saved.shareToKeep ? saved.displayPath : null;
  return saved.displayPath;
}
