import type {
  ChatMessage, Department, Person, Presence, Room, SessionUser, ConnState,
} from "../electron/core/types";
import type {
  ApprovalBox, ApprovalDocumentDetail, ApprovalList, MailFolders, MailListPage, MailMessage, MenuEntry,
} from "../electron/core/portal";
import type { BotSettingsResult } from "../electron/core/bot-settings";
import type { BackupFileType, BackupItem } from "../electron/core/backup";
import type { CaptureResult } from "../electron/core/capture";
import type { PreviewMode } from "../electron/core/doc-preview";
import type { CustomTheme, ThemePresetId, ThemeState } from "../electron/core/theme";
import type { PubsubCaps, PubsubDetail, PubsubPage, PubsubTarget } from "../electron/core/pubsub";
import type { SavedInput, SavedMessage } from "../electron/core/saved";
import type { Reminder, ReminderInput } from "../electron/core/reminders";
import type { ScheduledMessage, ScheduledInput } from "../electron/core/scheduled-send";
import type { StatusCaps } from "../electron/core/status-message";
import type { ReactionsCaps, ReactionMap } from "../electron/core/reactions";
import type { Poll, PollCaps, PollInput } from "../electron/core/polls";
import type { EditCaps, ReplyTarget } from "../electron/core/edit-reply";
import type { BotSummaryCaps } from "../electron/core/bot-summary";
import type { SummaryMode } from "./lib/bot-summary";
import type { BotSettingsSnapshot } from "./lib/personal-bot-settings";
import type { Language } from "./lib/i18n-core";
import type { GlobalSearchCaps, GlobalSearchProgress, GlobalSearchQuery, GlobalSearchResult } from "./lib/global-search";
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
  dndEnabled: boolean;
  dndDays: number[];
  dndStartMin: number;
  dndEndMin: number;
  dndManualUntil?: number;
  themePreset?: ThemePresetId;
  customThemes?: CustomTheme[];
  activeThemeId?: string;
  /** 다국어 (ko/en/ja/zh_CN/zh_TW/vi), default "ko". */
  language?: Language;
  hasSavedPassword?: boolean;
};

export type Bridge = {
  call<T = any>(ch: string, ...args: unknown[]): Promise<T>;
  deleteChatMessages(ids: number[]): Promise<{ ok: true; count: number }>;
  forwardToRoom(roomSeq: number, cryptIds: string[]): Promise<{ ok: true; count: number }>;
  forwardToMembers(memberSeqs: number[], cryptIds: string[], roomType: "single" | "group"): Promise<{ ok: true; count: number }>;
  registerNotice(key: string, messageId: number): Promise<Room>;
  setRoomPush(key: string, usePush: boolean): Promise<void>;
  /** 문서 미리보기: server viewer (UBM_DOC_VIEWER_URL) or local download → in-app window / OS default app. */
  previewFile(cryptId: string, messageId: number, name: string, ext?: string): Promise<{ mode: PreviewMode }>;
  /** 화면 캡쳐: region-select overlay; null when cancelled (Esc). */
  captureScreen(): Promise<CaptureResult | null>;
  backup: {
    config(): Promise<{ historyClearEnabled: boolean }>;
    request(key: string, from: string, to: string, fileType: BackupFileType): Promise<{ ok: true }>;
    list(): Promise<BackupItem[]>;
    download(key: string, backupId: number, mode?: "downloads" | "saveAs" | "open"): Promise<string | null>;
    remove(key: string, backupId: number): Promise<{ ok: true }>;
    clearHistory(key: string, messageId: number, confirmed: boolean): Promise<{ ok: true }>;
  };
  /** 공지톡: list/detail read-only; send/remove refused by main unless UBM_PUBSUB_SEND=1 (+ self-only guard). */
  pubsub: {
    caps(): Promise<PubsubCaps>;
    list(page?: number): Promise<PubsubPage>;
    detail(id: number): Promise<PubsubDetail>;
    send(message: string, targets: PubsubTarget[]): Promise<{ ok: true; count: number }>;
    remove(id: number): Promise<{ ok: true }>;
  };
  zoom: {
    caps(): Promise<import("../electron/core/zoom").ZoomCaps>;
    connect(key: string): Promise<{ connected: boolean }>;
    createMeeting(key: string): Promise<{ joinUrl: string } | { needsConnect: true }>;
  };
  /** 테마 업로드: sanitized custom CSS files (main owns the files + ids). import() = null when the dialog is cancelled. */
  theme: {
    list(): Promise<ThemeState>;
    import(): Promise<(ThemeState & { id: string; removed: string[] }) | null>;
    remove(id: string): Promise<ThemeState>;
    activate(id: string | null): Promise<ThemeState>;
    css(id?: string): Promise<string>;
  };
  /** 통합 검색: local cache + throttled per-room server fan-out; progress streams via onProgress. */
  search: {
    caps(): Promise<GlobalSearchCaps>;
    global(searchId: number, query: GlobalSearchQuery): Promise<GlobalSearchResult>;
    cancel(): Promise<void>;
    cacheInfo(): Promise<{ docs: number }>;
    clearCache(): Promise<{ docs: number }>;
    onProgress(cb: (p: GlobalSearchProgress) => void): () => void;
  };
  listFavorites(): Promise<Person[]>;
  addFavorite(id: number): Promise<{ ok: true }>;
  removeFavorite(id: number): Promise<{ ok: true }>;
  /** 저장한 메시지: client-local only (JSON in userData), no server calls. */
  saved: {
    list(): Promise<SavedMessage[]>;
    add(input: SavedInput): Promise<SavedMessage>;
    remove(id: string): Promise<{ ok: true }>;
  };
  /** 나중에 알림: client-local reminders; main fires a desktop notification when due. */
  reminders: {
    list(): Promise<Reminder[]>;
    add(input: ReminderInput): Promise<Reminder>;
    remove(id: string): Promise<{ ok: true }>;
  };
  /** 예약 전송: client-local queue; main sends on a timer via the normal send path. */
  scheduled: {
    list(): Promise<ScheduledMessage[]>;
    add(input: ScheduledInput): Promise<ScheduledMessage>;
    cancel(id: string): Promise<{ ok: true }>;
    sendNow(id: string): Promise<{ ok: true }>;
  };
  /** 방해 금지 시간: main computes the manual window; suppression is client-side. */
  dnd: {
    manual(hours: number): Promise<{ manualUntil: number }>;
  };
  /** 상태 메시지 (XMPP / server fallback), gated by UBM_STATUS_XMPP=1 or UBM_STATUS_SERVER=1. */
  status: {
    caps(): Promise<StatusCaps>;
    get(): Promise<{ text: string | null }>;
    set(text: string): Promise<{ text: string | null }>;
    presenceStatus(): Promise<Record<number, string>>;
  };
  /** 이모지 리액션 (our server, keyed by roomSeq:messageId), on by default; UBM_REACTIONS=0 disables. */
  reactions: {
    caps(): Promise<ReactionsCaps>;
    list(roomSeq: number, messageIds: number[]): Promise<ReactionMap>;
    toggle(roomSeq: number, messageId: number, emoji: string): Promise<ReactionMap>;
  };
  /** 투표 (our server /v1/polls; bot posts the poll + results), gated by UBM_POLLS=1. */
  polls: {
    caps(): Promise<PollCaps>;
    create(input: PollInput): Promise<Poll>;
    get(id: number): Promise<Poll>;
    vote(id: number, optionIndex: number): Promise<Poll>;
    close(id: number): Promise<Poll>;
  };
  /** 메시지 수정 / 답장(인용): M 패턴 (delete+resend / quote). Gated by UBM_EDIT (default on); self-only guard applies. */
  edit: {
    caps(): Promise<EditCaps>;
    edit(key: string, origMessageId: number, newText: string): Promise<{ ok: true; messageId?: number }>;
    reply(key: string, target: ReplyTarget, replyText: string): Promise<{ ok: true; messageId?: number }>;
  };
  /** 유비온봇 대화/안읽은 메시지 요약: posts a /요약 command to the 나 room. Gated by UBM_BOT_SUMMARY=1; self-only guard applies. */
  botSummary: {
    caps(): Promise<BotSummaryCaps>;
    request(roomKey: string, mode: SummaryMode, recentN?: number): Promise<{ ok: true; messageId?: number }>;
  };
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
    calendarToday(): Promise<import("../electron/core/portal").PortalList<import("../electron/core/portal").CalendarEvent>>;
    approvalDoc(id: number | string): Promise<ApprovalDocumentDetail>;
    mailUpload(name: string, data: ArrayBuffer, mime?: string): Promise<import("../electron/core/mail-attach").UploadedAttach>;
    mailCaps(): Promise<{ delete: boolean }>;
    mailDelete(folder: string, uids: number[]): Promise<{ ok: true; count: number }>;
    mailSend(draft: import("../electron/core/mail-compose").MailDraft): Promise<{ ok: true }>;
    approvalAction(kind: "approve" | "return", id: number | string, comment?: string): Promise<{ ok: true }>;
    flexPending(force?: boolean): Promise<{ count: number | null; at: number; error?: string }>;
  };
  /**
   * 내 봇 settings window. Present in Electron. Browser preview omits it and the
   * gear falls back to the in-app panel.
   */
  personalBotSettings?: {
    open(userId: number): Promise<void>;
    changed(userId: number, snapshot: BotSettingsSnapshot): Promise<void>;
    onChanged(cb: (payload: { userId: number } & BotSettingsSnapshot) => void): () => void;
  };
  /** Google Drive / Calendar for 내 봇. Tokens stay in the main process. */
  google: {
    status(userId: number): Promise<{ connectors: { id: "google-drive" | "google-calendar"; connected: boolean; account?: string }[] }>;
    connect(userId: number, id: "google-drive" | "google-calendar"): Promise<{ connected: true; account?: string }>;
    disconnect(userId: number, id: "google-drive" | "google-calendar"): Promise<{ connected: false }>;
    driveList(userId: number, args?: { query?: string; mime?: string; folderId?: string; limit?: number }): Promise<{ ok: true; files: { id: string; name: string; mimeType: string; modifiedTime?: string; folder?: string }[]; note?: string } | { ok: false; code: string; message: string }>;
    driveRead(userId: number, args: { fileId?: unknown; maxChars?: unknown }): Promise<{ ok: true; name: string; mimeType: string; text: string; truncated?: true; note?: string } | { ok: false; code: string; message: string; name?: string; mimeType?: string }>;
    calendarToday(userId: number): Promise<{ ok: true; items: { summary: string; start: string; end: string; allDay: boolean; location: string }[] } | { ok: false; code: string; message: string }>;
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
