import { contextBridge, ipcRenderer, webUtils } from "electron";

type Res<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T = any>(ch: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(ch, ...args)) as Res<T>;
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

function sub(ch: string, cb: (p: any) => void) {
  const l = (_e: unknown, p: unknown) => cb(p);
  ipcRenderer.on(ch, l);
  return () => ipcRenderer.removeListener(ch, l);
}

const api = {
  call,
  deleteChatMessages: (ids: number[]) => call<{ ok: true; count: number }>("msg:delete", ids),
  forwardToRoom: (roomSeq: number, cryptIds: string[]) => call<{ ok: true; count: number }>("msg:forwardRoom", roomSeq, cryptIds),
  forwardToMembers: (memberSeqs: number[], cryptIds: string[], roomType: "single" | "group") =>
    call<{ ok: true; count: number }>("msg:forwardMembers", memberSeqs, cryptIds, roomType),
  registerNotice: (key: string, messageId: number) => call<import("./core/types").Room>("room:notice", key, messageId),
  setRoomPush: (key: string, usePush: boolean) => call<void>("rooms:setPush", key, usePush),
  previewFile: (cryptId: string, messageId: number, name: string, ext?: string) =>
    call<{ mode: import("./core/doc-preview").PreviewMode }>("file:preview", cryptId, messageId, name, ext),
  captureScreen: () => call<import("./core/capture").CaptureResult | null>("capture:start"),
  backup: {
    config: () => call<{ historyClearEnabled: boolean }>("backup:config"),
    request: (key: string, from: string, to: string, fileType: "TXT" | "HTML") => call<{ ok: true }>("backup:request", key, from, to, fileType),
    list: () => call<import("./core/backup").BackupItem[]>("backup:list"),
    download: (key: string, backupId: number, mode?: "downloads" | "saveAs" | "open") => call<string | null>("backup:download", key, backupId, mode),
    remove: (key: string, backupId: number) => call<{ ok: true }>("backup:delete", key, backupId),
    clearHistory: (key: string, messageId: number, confirmed: boolean) => call<{ ok: true }>("history:clear", key, messageId, confirmed),
  },
  pubsub: {
    caps: () => call<import("./core/pubsub").PubsubCaps>("pubsub:caps"),
    list: (page = 0) => call<import("./core/pubsub").PubsubPage>("pubsub:list", page),
    detail: (id: number) => call<import("./core/pubsub").PubsubDetail>("pubsub:detail", id),
    send: (message: string, targets: import("./core/pubsub").PubsubTarget[]) =>
      call<{ ok: true; count: number }>("pubsub:send", { message, targets, range: "partial" }),
    remove: (id: number) => call<{ ok: true }>("pubsub:delete", id),
  },
  listFavorites: () => call<import("./core/types").Person[]>("favorites:list"),
  addFavorite: (id: number) => call<{ ok: true }>("favorites:add", id),
  removeFavorite: (id: number) => call<{ ok: true }>("favorites:remove", id),
  openChatBot: (brandName?: string) => call<void>("app:openChatBot", brandName),
  onEvent: (cb: (e: { type: string; payload: any }) => void) => sub("core:event", cb),
  onOpenRoom: (cb: (key: string) => void) => sub("nav:openRoom", cb),
  onOpenSettings: (cb: () => void) => sub("nav:settings", cb),
  onFocus: (cb: (f: boolean) => void) => sub("window:focus", cb),
  onBadge: (cb: (n: number) => void) => sub("badge:changed", cb),
  onLockChanged: (cb: (s: { locked: boolean }) => void) => sub("lock:changed", cb),
  onUpdate: (cb: (s: any) => void) => sub("update:status", cb),
  portal: {
    get: (widgetId?: string) => call("portal:get", widgetId),
    refresh: () => call("portal:refresh"),
    open: (url: string, mode?: "external" | "inapp") => call<void>("portal:open", url, mode),
    setActive: (active: boolean) => call<void>("portal:setActive", active),
    menu: (force?: boolean) => call<{ items: import("./core/portal").MenuEntry[]; source: "server" | "static" }>("portal:menu", force),
    mailFolders: () => call<import("./core/portal").MailFolders>("portal:mailFolders"),
    mailList: (folder: string, page: number, keyword = "") => call<import("./core/mail").MailListPage>("portal:mailList", folder, page, keyword),
    mailRead: (folder: string, uid: number) => call<import("./core/mail").MailMessage>("portal:mailRead", folder, uid),
    approvalList: (box: import("./core/portal").ApprovalBox, page: number, keyword = "") =>
      call<import("./core/portal").ApprovalList>("portal:approvalList", box, page, keyword),
    approvalCounts: () => call<{ todo: number; upcoming: number }>("portal:approvalCounts"),
    approvalDoc: (id: number | string) => call<import("./core/portal").ApprovalDocumentDetail>("portal:approvalDoc", id),
    mailUpload: (name: string, data: ArrayBuffer, mime?: string) => call<import("./core/mail-attach").UploadedAttach>("portal:mailUpload", name, data, mime),
    mailCaps: () => call<{ delete: boolean }>("portal:mailCaps"),
    mailDelete: (folder: string, uids: number[]) => call<{ ok: true; count: number }>("portal:mailDelete", folder, uids),
    mailSend: (draft: import("./core/mail-compose").MailDraft) => call<{ ok: true }>("portal:mailSend", draft),
    approvalAction: (kind: "approve" | "return", id: number | string, comment = "") =>
      call<{ ok: true }>("portal:approvalAction", kind, id, comment),
    flexPending: (force?: boolean) => call<{ count: number | null; at: number; error?: string }>("portal:flexPending", force),
  },
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  platform: process.platform,
};

contextBridge.exposeInMainWorld("ubion", api);
export type UbionApi = typeof api;
