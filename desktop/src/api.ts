import type {
  ChatMessage, Department, Person, Presence, Room, SessionUser, ConnState,
} from "../electron/core/types";
import type {
  ApprovalBox, ApprovalDocumentDetail, ApprovalList, MailFolders, MailListPage, MailMessage, MenuEntry,
} from "../electron/core/portal";
import type { BotSettingsResult } from "../electron/core/bot-settings";
import type { BackupFileType, BackupItem } from "../electron/core/backup";
export type { ChatMessage, Department, Person, Presence, Room, SessionUser, ConnState, BotSettingsResult };

export type LockStatus = { enabled: boolean; locked: boolean; timeoutMin: number };
export type UnlockResult = { ok: true } | { ok: false; error: string; cooldownMs?: number };

/** Metadata returned by the pick-only IPC; the file is uploaded by path when the tray is sent. */
export type PickedStagingFile = {
  path: string; name: string; size: number; lastModified: number; type: string;
  /** Image bytes (small files only) for an object-URL thumbnail. */
  preview?: Uint8Array;
};

export type PickedStagingResult = {
  files: PickedStagingFile[];
  errors: string[];
};

export type Settings = {
  serverUrl: string; username: string; rememberMe: boolean; autoLogin: boolean;
  theme: "system" | "light" | "dark"; notifications: boolean; notificationPreview: boolean;
  notificationSound: boolean; launchAtLogin: boolean; closeToTray: boolean; downloadDir: string; askSaveLocation: boolean; lastSaveDir?: string;
  fontSize: number; autoUpdate: boolean; portalPostNotify: boolean; portalOpenMode: "external" | "inapp"; portalOpenModeChosen?: boolean;
  flexAutoLogin?: boolean;
  awayMinutes: 0 | 1 | 5 | 10 | 15;
  mobileNotice: boolean;
  lockTimeoutMin: 0 | 1 | 5 | 10 | 30 | 60;
  hasSavedPassword?: boolean;
};

export type Bridge = {
  call<T = any>(ch: string, ...args: unknown[]): Promise<T>;
  deleteChatMessages(ids: number[]): Promise<{ ok: true; count: number }>;
  forwardToRoom(roomSeq: number, cryptIds: string[]): Promise<{ ok: true; count: number }>;
  forwardToMembers(memberSeqs: number[], cryptIds: string[], roomType: "single" | "group"): Promise<{ ok: true; count: number }>;
  registerNotice(key: string, messageId: number): Promise<Room>;
  setRoomPush(key: string, usePush: boolean): Promise<void>;
  backup: {
    config(): Promise<{ historyClearEnabled: boolean }>;
    request(key: string, from: string, to: string, fileType: BackupFileType): Promise<{ ok: true }>;
    list(): Promise<BackupItem[]>;
    download(key: string, backupId: number, mode?: "downloads" | "saveAs" | "open"): Promise<string | null>;
    remove(key: string, backupId: number): Promise<{ ok: true }>;
    clearHistory(key: string, messageId: number, confirmed: boolean): Promise<{ ok: true }>;
  };
  listFavorites(): Promise<Person[]>;
  addFavorite(id: number): Promise<{ ok: true }>;
  removeFavorite(id: number): Promise<{ ok: true }>;
  openChatBot(brandName?: string): Promise<void>;
  onEvent(cb: (e: { type: string; payload: any }) => void): () => void;
  onOpenRoom(cb: (key: string) => void): () => void;
  onOpenSettings(cb: () => void): () => void;
  onFocus(cb: (f: boolean) => void): () => void;
  onBadge(cb: (n: number) => void): () => void;
  onLockChanged(cb: (s: { locked: boolean }) => void): () => void;
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
    mailUpload(name: string, data: ArrayBuffer, mime?: string): Promise<import("../electron/core/mail-attach").UploadedAttach>;
    mailCaps(): Promise<{ delete: boolean }>;
    mailDelete(folder: string, uids: number[]): Promise<{ ok: true; count: number }>;
    mailSend(draft: import("../electron/core/mail-compose").MailDraft): Promise<{ ok: true }>;
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
