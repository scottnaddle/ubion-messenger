import { t } from "./lib/i18n";

/** Staged chat attachments: a file is only uploaded when the composer is submitted. */

/** Same limit as main's files:sendPaths handler. */
export const MAX_FILE_SIZE = 300 * 1024 * 1024;
export const MAX_FILE_SIZE_LABEL = "300MB";

export type AttachFileInput = {
  name: string;
  size: number;
  lastModified?: number;
  type?: string;
  /** Set for files picked from disk; sending keeps the path-based upload path. */
  path?: string;
  /** Browser File/Blob for drag-drop and paste. Unknown keeps this module DOM-free. */
  file?: unknown;
  /** Small image preview bytes returned by the pick-only IPC. */
  previewData?: Uint8Array | ArrayBuffer;
};

export type StagedFile = {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  type: string;
  path?: string;
  file?: unknown;
  previewData?: Uint8Array | ArrayBuffer;
  previewUrl?: string;
};

export type AddFilesReport = {
  files: StagedFile[];
  added: StagedFile[];
  duplicates: StagedFile[];
  errors: string[];
  rejected: Array<{ file: AttachFileInput; reason: string }>;
};

export type SendPlanStep<T extends AttachFileInput = AttachFileInput> =
  | { type: "file"; file: T }
  | { type: "text"; text: string };

/** Identity used for de-duplication: same name + size + mtime means the same file. */
export function fileKey(file: { name: string; size: number; lastModified?: number }): string {
  const size = Number.isFinite(file.size) ? file.size : 0;
  const mtime = Number.isFinite(file.lastModified) ? Number(file.lastModified) : 0;
  return `${file.name}\u0000${size}\u0000${mtime}`;
}

/** Human file size, matching the chips' 1024-based units. */
export function formatSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Existing upload limit/message, applied when a file is staged instead of after upload starts. */
export function validateFile(file: Pick<AttachFileInput, "name" | "size">): string | null {
  const size = Number(file.size);
  if (Number.isFinite(size) && size > MAX_FILE_SIZE) {
    return t("{name}: {limit}를 초과합니다", { name: file.name, limit: MAX_FILE_SIZE_LABEL });
  }
  return null;
}

export function isImageFile(file: { type?: string; name?: string }): boolean {
  if (/^image\//i.test(file.type || "")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/i.test(file.name || "");
}

export function stageFile(file: AttachFileInput): StagedFile {
  const lastModified = Number.isFinite(file.lastModified) ? Number(file.lastModified) : 0;
  const id = fileKey({ name: file.name, size: file.size, lastModified });
  return {
    id,
    name: file.name,
    size: Number.isFinite(file.size) ? Number(file.size) : 0,
    lastModified,
    type: file.type || "",
    path: file.path,
    file: file.file,
    previewData: file.previewData,
  };
}

/** Add files, de-duplicating by name+size+lastModified and reporting rejected files. */
export function addFilesWithReport(current: readonly StagedFile[], incoming: readonly AttachFileInput[]): AddFilesReport {
  const files = [...current];
  const added: StagedFile[] = [];
  const duplicates: StagedFile[] = [];
  const errors: string[] = [];
  const rejected: AddFilesReport["rejected"] = [];
  const seen = new Set(current.map((f) => f.id || fileKey(f)));
  for (const input of incoming) {
    const reason = validateFile(input);
    if (reason) {
      errors.push(reason);
      rejected.push({ file: input, reason });
      continue;
    }
    const staged = stageFile(input);
    if (seen.has(staged.id)) {
      duplicates.push(staged);
      continue;
    }
    seen.add(staged.id);
    files.push(staged);
    added.push(staged);
  }
  return { files, added, duplicates, errors, rejected };
}

/** Add staged files and return the new tray (invalid/duplicate files are skipped). */
export function addFiles(current: readonly StagedFile[], incoming: readonly AttachFileInput[]): StagedFile[] {
  return addFilesWithReport(current, incoming).files;
}

/** De-duplicate a list while preserving order. */
export function dedupeFiles<T extends AttachFileInput>(files: readonly T[]): T[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = fileKey(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Remove by staged file, id/key, or name. */
export function removeFile<T extends StagedFile>(files: readonly T[], target: T | string): T[] {
  const id = typeof target === "string" ? target : target.id || fileKey(target);
  return files.filter((file) => file.id !== id && fileKey(file) !== id && file.name !== id);
}

export const addToTray = addFiles;
export const dedupe = dedupeFiles;
export const removeStaged = removeFile;

/** Add missing staged files without re-staging (keeps previews and file handles intact). */
export function mergeStaged<T extends StagedFile>(current: readonly T[], incoming: readonly T[]): T[] {
  const files = [...current];
  const seen = new Set(files.map((file) => file.id || fileKey(file)));
  for (const file of incoming) {
    const key = file.id || fileKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(file);
  }
  return files;
}

export type DroppedItemLike = { name: string; isDirectory?: boolean };

/** Split dropped entries into real files and folders so folders never become unsendable chips. */
export function splitDroppedFiles<T extends DroppedItemLike>(
  items: readonly T[],
): { files: T[]; folders: T[] } {
  const files: T[] = [];
  const folders: T[] = [];
  for (const item of items) (item.isDirectory ? folders : files).push(item);
  return { files, folders };
}

export function folderSkipMessage(names: readonly string[]): string {
  const unique = [...new Set(names.filter(Boolean))];
  return unique.length ? t("폴더는 첨부할 수 없습니다: {names}", { names: unique.join(", ") }) : "";
}

export type SendOutcome<T extends AttachFileInput = AttachFileInput> = {
  succeeded: T[];
  failed: T[];
  textSent: boolean;
};

/** Send files in order, then text only when every file succeeded. */
export async function executeSendPlan<T extends AttachFileInput>(
  plan: readonly SendPlanStep<T>[],
  sendFile: (file: T) => Promise<boolean>,
  sendText: (text: string) => Promise<void>,
  onFileDone?: (file: T, ok: boolean) => void,
): Promise<SendOutcome<T>> {
  const succeeded: T[] = [];
  const failed: T[] = [];
  let textSent = false;
  for (const step of plan) {
    if (step.type === "file") {
      let ok = false;
      try {
        ok = await sendFile(step.file);
      } catch {
        ok = false;
      }
      (ok ? succeeded : failed).push(step.file);
      onFileDone?.(step.file, ok);
    } else if (!failed.length) {
      await sendText(step.text);
      textSent = true;
    }
  }
  return { succeeded, failed, textSent };
}

/**
 * Files are sent first in tray order, each as its own attach message; the typed text
 * follows as a separate normal message when it is not blank.
 */
export function sendPlan<T extends AttachFileInput>(files: readonly T[], text: string): SendPlanStep<T>[] {
  const steps: SendPlanStep<T>[] = files.map((file) => ({ type: "file" as const, file }));
  const trimmed = typeof text === "string" ? text.replace(/\s+$/, "") : "";
  if (trimmed.trim()) steps.push({ type: "text", text: trimmed });
  return steps;
}
