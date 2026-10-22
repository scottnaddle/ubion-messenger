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
  onEvent: (cb: (e: { type: string; payload: any }) => void) => sub("core:event", cb),
  onOpenRoom: (cb: (key: string) => void) => sub("nav:openRoom", cb),
  onOpenSettings: (cb: () => void) => sub("nav:settings", cb),
  onFocus: (cb: (f: boolean) => void) => sub("window:focus", cb),
  onBadge: (cb: (n: number) => void) => sub("badge:changed", cb),
  onUpdate: (cb: (s: any) => void) => sub("update:status", cb),
  portal: {
    get: (widgetId?: string) => call("portal:get", widgetId),
    refresh: () => call("portal:refresh"),
    open: (url: string, mode?: "external" | "inapp") => call<void>("portal:open", url, mode),
    setActive: (active: boolean) => call<void>("portal:setActive", active),
    menu: (force?: boolean) => call<{ items: import("./core/portal").MenuEntry[]; source: "server" | "static" }>("portal:menu", force),
    mailFolders: () => call<import("./core/portal").MailFolders>("portal:mailFolders"),
    approvalList: (box: import("./core/portal").ApprovalBox, page: number, keyword = "") =>
      call<import("./core/portal").ApprovalList>("portal:approvalList", box, page, keyword),
    approvalCounts: () => call<{ todo: number; upcoming: number }>("portal:approvalCounts"),
    approvalDoc: (id: number | string) => call<import("./core/portal").ApprovalDocumentDetail>("portal:approvalDoc", id),
    flexPending: (force?: boolean) => call<{ count: number | null; at: number; error?: string }>("portal:flexPending", force),
  },
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  platform: process.platform,
};

contextBridge.exposeInMainWorld("ubion", api);
export type UbionApi = typeof api;
