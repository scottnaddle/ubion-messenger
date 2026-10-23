import type {
  ChatMessage, Department, Person, Presence, Room, SessionUser, ConnState,
} from "../electron/core/types";
import type {
  ApprovalBox, ApprovalDocumentDetail, ApprovalList, MailFolders, MailListPage, MailMessage, MenuEntry,
} from "../electron/core/portal";
export type { ChatMessage, Department, Person, Presence, Room, SessionUser, ConnState };

export type Settings = {
  serverUrl: string; username: string; rememberMe: boolean; autoLogin: boolean;
  theme: "system" | "light" | "dark"; notifications: boolean; notificationPreview: boolean;
  notificationSound: boolean; launchAtLogin: boolean; closeToTray: boolean; downloadDir: string;
  fontSize: number; autoUpdate: boolean; portalPostNotify: boolean; portalOpenMode: "external" | "inapp"; portalOpenModeChosen?: boolean;
  flexAutoLogin?: boolean;
  hasSavedPassword?: boolean;
};

export type Bridge = {
  call<T = any>(ch: string, ...args: unknown[]): Promise<T>;
  onEvent(cb: (e: { type: string; payload: any }) => void): () => void;
  onOpenRoom(cb: (key: string) => void): () => void;
  onOpenSettings(cb: () => void): () => void;
  onFocus(cb: (f: boolean) => void): () => void;
  onBadge(cb: (n: number) => void): () => void;
  onUpdate(cb: (s: UpdateStatus) => void): () => void;
  portal: {
    get(widgetId?: string): Promise<any>;
    refresh(): Promise<any>;
    open(url: string, mode?: "external" | "inapp"): Promise<void>;
    setActive(active: boolean): Promise<void>;
    menu(force?: boolean): Promise<{ items: MenuEntry[]; source: "server" | "static" }>;
    mailFolders(): Promise<MailFolders>;
    mailList(folder: string, page: number, keyword?: string): Promise<MailListPage>;
    mailRead(folder: string, uid: number): Promise<MailMessage>;
    approvalList(box: ApprovalBox, page: number, keyword?: string): Promise<ApprovalList>;
    approvalCounts(): Promise<{ todo: number; upcoming: number }>;
    approvalDoc(id: number | string): Promise<ApprovalDocumentDetail>;
    approvalAction(kind: "approve" | "return", id: number | string, comment?: string): Promise<{ ok: true }>;
    flexPending(force?: boolean): Promise<{ count: number | null; at: number; error?: string }>;
  };
  pathForFile(f: File): string;
  platform: string;
};

declare global {
  interface Window { ubion: Bridge }
}

export const api = () => window.ubion;

/** Server-relative image path → authenticated custom protocol URL served by main process. */
export function media(p?: string | null): string {
  if (!p) return "";
  if (p.startsWith("data:") || p.startsWith("ubion-media:")) return p;
  let path = p;
  try {
    if (/^https?:\/\//.test(p)) { const u = new URL(p); path = u.pathname + u.search; }
  } catch { /* keep */ }
  if (!path.startsWith("/")) path = "/" + path;
  return "ubion-media://h" + path;
}

export type UpdateStatus = {
  state: "idle" | "checking" | "none" | "available" | "downloading" | "downloaded" | "error";
  current: string; version?: string; percent?: number; file?: string; message?: string; pageUrl?: string;
  checkedAt?: number; supported?: boolean; platform?: string;
};
