import type {
  ChatMessage, Department, Person, Presence, Room, SessionUser, ConnState,
} from "../electron/core/types";
export type { ChatMessage, Department, Person, Presence, Room, SessionUser, ConnState };

export type Settings = {
  serverUrl: string; username: string; rememberMe: boolean; autoLogin: boolean;
  theme: "system" | "light" | "dark"; notifications: boolean; notificationPreview: boolean;
  notificationSound: boolean; launchAtLogin: boolean; closeToTray: boolean; downloadDir: string;
  fontSize: number; autoUpdate: boolean; hasSavedPassword?: boolean;
};

export type Bridge = {
  call<T = any>(ch: string, ...args: unknown[]): Promise<T>;
  onEvent(cb: (e: { type: string; payload: any }) => void): () => void;
  onOpenRoom(cb: (key: string) => void): () => void;
  onOpenSettings(cb: () => void): () => void;
  onFocus(cb: (f: boolean) => void): () => void;
  onBadge(cb: (n: number) => void): () => void;
  onUpdate(cb: (s: UpdateStatus) => void): () => void;
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
