import type { ApprovalDoc, MailItem } from "../../electron/core/portal";

/**
 * Home dashboard mail and approval rows open the in-app screens.
 * Targets are a mailbox folder + uid, or an approval box + document id.
 * No tenant host is involved.
 */
export type MailOpenTarget = { folder: string; uid: number; seen: boolean };
export type ApprovalOpenTarget = { box: "todo" | "upcoming"; id: number; documentId?: number };

export function mailOpenTarget(m: Pick<MailItem, "id" | "folderFullName" | "seen">): MailOpenTarget | null {
  const uid = Number(m.id);
  const rawFolder = String(m.folderFullName ?? "");
  if (/[\r\n\0]/.test(rawFolder)) return null;
  const folder = rawFolder.trim() || "Inbox";
  if (!Number.isInteger(uid) || uid <= 0) return null;
  if (folder.length > 300) return null;
  return { folder, uid, seen: !!m.seen };
}

export function approvalOpenTarget(
  d: Pick<ApprovalDoc, "id" | "documentId">,
  box: "todo" | "upcoming",
): ApprovalOpenTarget | null {
  const id = Number(d.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const raw = d.documentId == null ? undefined : Number(d.documentId);
  const documentId = raw != null && Number.isInteger(raw) && raw > 0 ? raw : undefined;
  return documentId != null ? { box, id, documentId } : { box, id };
}

/** Same id the in-app Approval screen loads when a list row is opened. */
export function approvalDocId(t: { id: number; documentId?: number }): number {
  return t.documentId ?? t.id;
}
