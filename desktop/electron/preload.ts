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
  zoom: {
    caps: () => call<import("./core/zoom").ZoomCaps>("zoom:caps"),
    connect: (key: string) => call<{ connected: boolean }>("zoom:connect", key),
    createMeeting: (key: string) => call<{ joinUrl: string } | { needsConnect: true }>("zoom:createMeeting", key),
  },
  theme: {
    list: () => call<import("./core/theme").ThemeState>("theme:list"),
    import: () => call<(import("./core/theme").ThemeState & { id: string; removed: string[] }) | null>("theme:import"),
    remove: (id: string) => call<import("./core/theme").ThemeState>("theme:remove", id),
    activate: (id: string | null) => call<import("./core/theme").ThemeState>("theme:activate", id),
    css: (id?: string) => call<string>("theme:css", id),
  },
  search: {
    caps: () => call<import("../src/lib/global-search").GlobalSearchCaps>("search:caps"),
    global: (searchId: number, query: import("../src/lib/global-search").GlobalSearchQuery) =>
      call<import("../src/lib/global-search").GlobalSearchResult>("search:global", searchId, query),
    cancel: () => call<void>("search:cancel"),
    cacheInfo: () => call<{ docs: number }>("search:cacheInfo"),
    clearCache: () => call<{ docs: number }>("search:clearCache"),
    onProgress: (cb: (p: import("../src/lib/global-search").GlobalSearchProgress) => void) => sub("search:progress", cb),
  },
  listFavorites: () => call<import("./core/types").Person[]>("favorites:list"),
  addFavorite: (id: number) => call<{ ok: true }>("favorites:add", id),
  removeFavorite: (id: number) => call<{ ok: true }>("favorites:remove", id),
  saved: {
    list: () => call<import("./core/saved").SavedMessage[]>("saved:list"),
    add: (input: import("./core/saved").SavedInput) => call<import("./core/saved").SavedMessage>("saved:add", input),
    remove: (id: string) => call<{ ok: true }>("saved:remove", id),
  },
  reminders: {
    list: () => call<import("./core/reminders").Reminder[]>("reminder:list"),
    add: (input: import("./core/reminders").ReminderInput) => call<import("./core/reminders").Reminder>("reminder:add", input),
    remove: (id: string) => call<{ ok: true }>("reminder:remove", id),
  },
  scheduled: {
    list: () => call<import("./core/scheduled-send").ScheduledMessage[]>("schedule:list"),
    add: (input: import("./core/scheduled-send").ScheduledInput) => call<import("./core/scheduled-send").ScheduledMessage>("schedule:add", input),
    cancel: (id: string) => call<{ ok: true }>("schedule:cancel", id),
    sendNow: (id: string) => call<{ ok: true }>("schedule:sendNow", id),
  },
  dnd: {
    manual: (hours: number) => call<{ manualUntil: number }>("dnd:manual", hours),
  },
  status: {
    caps: () => call<import("./core/status-message").StatusCaps>("status:caps"),
    get: () => call<{ text: string | null }>("status:get"),
    set: (text: string) => call<{ text: string | null }>("status:set", text),
    presenceStatus: () => call<Record<number, string>>("status:presenceStatus"),
  },
  reactions: {
    caps: () => call<import("./core/reactions").ReactionsCaps>("reactions:caps"),
    list: (roomSeq: number, messageIds: number[]) => call<import("./core/reactions").ReactionMap>("reactions:list", roomSeq, messageIds),
    toggle: (roomSeq: number, messageId: number, emoji: string) => call<import("./core/reactions").ReactionMap>("reactions:toggle", roomSeq, messageId, emoji),
  },
  polls: {
    caps: () => call<import("./core/polls").PollCaps>("polls:caps"),
    create: (input: import("./core/polls").PollInput) => call<import("./core/polls").Poll>("polls:create", input),
    get: (id: number) => call<import("./core/polls").Poll>("polls:get", id),
    vote: (id: number, optionIndex: number) => call<import("./core/polls").Poll>("polls:vote", id, optionIndex),
    close: (id: number) => call<import("./core/polls").Poll>("polls:close", id),
  },
  edit: {
    caps: () => call<import("./core/edit-reply").EditCaps>("edit:caps"),
    edit: (key: string, origMessageId: number, newText: string) =>
      call<{ ok: true; messageId?: number }>("msg:edit", key, origMessageId, newText),
    reply: (key: string, target: import("./core/edit-reply").ReplyTarget, replyText: string) =>
      call<{ ok: true; messageId?: number }>("msg:reply", key, target, replyText),
  },
  botSummary: {
    caps: () => call<import("./core/bot-summary").BotSummaryCaps>("bot:summary:caps"),
    request: (roomKey: string, mode: import("../src/lib/bot-summary").SummaryMode, recentN?: number) =>
      call<{ ok: true; messageId?: number }>("bot:summary:request", roomKey, mode, recentN),
  },
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
    calendarToday: () => call<import("./core/portal").PortalList<import("./core/portal").CalendarEvent>>("portal:calendarToday"),
    approvalDoc: (id: number | string) => call<import("./core/portal").ApprovalDocumentDetail>("portal:approvalDoc", id),
    mailUpload: (name: string, data: ArrayBuffer, mime?: string) => call<import("./core/mail-attach").UploadedAttach>("portal:mailUpload", name, data, mime),
    mailCaps: () => call<{ delete: boolean }>("portal:mailCaps"),
    mailDelete: (folder: string, uids: number[]) => call<{ ok: true; count: number }>("portal:mailDelete", folder, uids),
    mailSend: (draft: import("./core/mail-compose").MailDraft) => call<{ ok: true }>("portal:mailSend", draft),
    approvalAction: (kind: "approve" | "return", id: number | string, comment = "") =>
      call<{ ok: true }>("portal:approvalAction", kind, id, comment),
    flexPending: (force?: boolean) => call<{ count: number | null; at: number; error?: string }>("portal:flexPending", force),
  },
  personalBotSettings: {
    open: (userId: number) => call<void>("personalBot:openSettings", userId),
    changed: (userId: number, snapshot: import("../src/lib/personal-bot-settings").BotSettingsSnapshot) =>
      call<void>("personalBot:settingsChanged", userId, snapshot),
    onChanged: (cb: (payload: { userId: number } & import("../src/lib/personal-bot-settings").BotSettingsSnapshot) => void) =>
      sub("personal-bot:settings", cb),
  },
  google: {
    status: (userId: number) => call<{ connectors: { id: "google-drive" | "google-calendar"; connected: boolean; account?: string }[] }>("google:status", userId),
    connect: (userId: number, id: "google-drive" | "google-calendar") => call<{ connected: true; account?: string }>("google:connect", userId, id),
    disconnect: (userId: number, id: "google-drive" | "google-calendar") => call<{ connected: false }>("google:disconnect", userId, id),
    driveList: (userId: number, args?: { query?: string; mime?: string; folderId?: string; limit?: number }) =>
      call<{ ok: true; files: { id: string; name: string; mimeType: string; modifiedTime?: string; folder?: string }[]; note?: string } | { ok: false; code: string; message: string }>("google:driveList", userId, args),
    driveRead: (userId: number, args: { fileId?: unknown; maxChars?: unknown }) =>
      call<{ ok: true; name: string; mimeType: string; text: string; truncated?: true; note?: string } | { ok: false; code: string; message: string; name?: string; mimeType?: string }>("google:driveRead", userId, args),
    calendarToday: (userId: number) =>
      call<{ ok: true; items: { summary: string; start: string; end: string; allDay: boolean; location: string }[] } | { ok: false; code: string; message: string }>("google:calendarToday", userId),
  },
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  platform: process.platform,
};

contextBridge.exposeInMainWorld("ubion", api);
export type UbionApi = typeof api;
