/**
 * Notifications on mobile: stub. Native local/push notifications need @capacitor/local-notifications
 * or APNs (TODO). For now only the document title carries the unread count; nothing is logged.
 */
export type NotifyInput = { title: string; body?: string; roomKey?: string };

const BASE_TITLE = "UBION Messenger";

export function notify(_n: NotifyInput): void {
  /* no-op until a notification plugin is added */
}

/** Same title format App.tsx uses, so both writers agree. */
export function setBadge(n: number, doc: Document | undefined = globalThis.document): void {
  if (!doc) return;
  doc.title = n > 0 ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
}
