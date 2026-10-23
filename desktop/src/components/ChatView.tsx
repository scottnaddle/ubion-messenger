import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  api, media, type BotSettingsResult, type ChatMessage, type PickedStagingResult, type Presence, type Room, type SessionUser,
} from "../api";
import {
  filterMembers, findMentionTrigger, insertMention, parseMentionTokens,
  type MentionMember, type MentionTrigger,
} from "../lib/mention";
import {
  addFilesWithReport, executeSendPlan, folderSkipMessage, formatSize, isImageFile,
  mergeStaged, removeFile, sendPlan, splitDroppedFiles,
  type AttachFileInput, type StagedFile,
} from "../attach-tray";
import { applyReadReceipt, dedupeByMessageId, mergeReceipts, upsertMessage } from "../../electron/core/messages";
import {
  applyChatDelete, canDeleteMessage, CHAT_DELETE_CONFIRM, CHAT_DELETED_PLACEHOLDER, isDeletedMessage,
} from "../../electron/core/chat-delete";
import {
  isNoticeVisible, normalizeNoticeStatus, noticeStoreKey, noticeText,
  ROOM_NOTICE_CLOSE_CONFIRM, ROOM_NOTICE_REGISTER_CONFIRM,
} from "../../electron/core/room-notice";
import type { NoticeStatus } from "../../electron/core/types";
import type { ZoomCaps } from "../../electron/core/zoom";
import { REMINDER_PRESETS, type ReminderPreset } from "../../electron/core/reminders";
import { isSendEnter } from "../lib/composer";
import { botStatusLabel, type BotStatusEntry } from "../lib/bot-status";
import { isBotGroupRoom } from "../lib/bot-room";
import { FileCard, MediaViewer } from "./FileCard";
import { BackupModal } from "./BackupModal";
import { EmojiPicker } from "./EmojiPicker";
import {
  DAOU_STICKERS_ENABLED, insertAtSelection, loadRecentEmoji, parseEmoticonCodes, pushRecentEmoji, saveRecentEmoji,
} from "../lib/emoticon";
import { LinkPreview } from "./LinkPreview";
import { dayLabel, fileSize, parseTime, sameDay, timeLabel, URL_RE } from "../lib/format";
import { Avatar, Icon } from "./ui";
import { tk, useT } from "../lib/i18n";
import type { Toast, ToastFn } from "../App";

const PRES_LABEL: Record<Presence, string> = { online: tk("온라인"), away: tk("자리 비움"), busy: tk("다른 용무 중"), offline: tk("오프라인") };

type MentionCandidate = MentionMember & { image?: string };

const memberCache = new Map<string, MentionCandidate[]>();
const memberPending = new Map<string, Promise<MentionCandidate[]>>();

/** Fetch room members once per room; both the composer and message rendering share this cache. */
function loadRoomMembers(roomKey: string): Promise<MentionCandidate[]> {
  const cached = memberCache.get(roomKey);
  if (cached) return Promise.resolve(cached);
  const pending = memberPending.get(roomKey);
  if (pending) return pending;
  const req = api()
    .call<MentionCandidate[]>("rooms:members", roomKey)
    .then((list) => {
      const members = (Array.isArray(list) ? list : [])
        .filter((m) => m && typeof m.name === "string" && m.name)
        .map((m) => ({
          userId: Number(m.userId), name: m.name,
          position: m.position || "", department: m.department || "", image: m.image || "",
        }));
      memberCache.set(roomKey, members);
      return members;
    })
    // don't cache failures, so a transient error doesn't disable mentions for the room until restart
    .catch(() => [] as MentionCandidate[])
    .finally(() => { memberPending.delete(roomKey); });
  memberPending.set(roomKey, req);
  return req;
}

export function ChatView({
  room, me, focused, presence, botStatus, toast,
}: { room: Room; me: SessionUser; focused: boolean; presence?: Presence; botStatus?: BotStatusEntry; toast: ToastFn }) {
  const t = useT();
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [viewer, setViewer] = useState<ChatMessage | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<ChatMessage | null>(null);
  const [confirmNotice, setConfirmNotice] = useState<ChatMessage | null>(null);
  const [remindTarget, setRemindTarget] = useState<ChatMessage | null>(null);
  const [noticeStatus, setNoticeStatus] = useState<NoticeStatus>("normal");
  const [roomMenu, setRoomMenu] = useState<{ x: number; y: number } | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [zoomCaps, setZoomCaps] = useState<ZoomCaps | null>(null);
  const [zoomBusy, setZoomBusy] = useState(false);
  const [composerInsert, setComposerInsert] = useState<ComposerInsert | null>(null);
  const [roomMembers, setRoomMembers] = useState<MentionCandidate[]>([]);
  const [botAutonomy, setBotAutonomy] = useState(false);
  const [botLoading, setBotLoading] = useState(false);
  const [botSaving, setBotSaving] = useState(false);
  const [botError, setBotError] = useState("");
  const [botDisabled, setBotDisabled] = useState(false);
  const isGroupRoom = room.kind === "room" && !room.isSelf;
  const botRoom = isBotGroupRoom(room, roomMembers);
  const memberNames = useMemo(() => roomMembers.map((m) => m.name), [roomMembers]);
  const listRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const prevHeight = useRef<number | null>(null);
  const lastReadSent = useRef<number>(0);
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const stagedRef = useRef<StagedFile[]>([]);
  const setStagedFiles = useCallback((next: StagedFile[]) => {
    stagedRef.current = next;
    setStaged(next);
  }, []);
  const revokePreviews = useCallback((files: readonly StagedFile[]) => {
    for (const file of files) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
  }, []);
  const makePreview = useCallback((file: StagedFile): StagedFile => {
    if (file.previewUrl || !isImageFile(file)) return file;
    try {
      if (file.file instanceof Blob) return { ...file, previewUrl: URL.createObjectURL(file.file) };
      if (file.previewData) {
        const blob = new Blob([file.previewData as unknown as BlobPart], { type: file.type || "image/*" });
        return { ...file, previewUrl: URL.createObjectURL(blob) };
      }
    } catch {
      // Thumbnail is optional; keep the file chip usable.
    }
    return file;
  }, []);
  const stageFiles = useCallback((incoming: AttachFileInput[]) => {
    if (!incoming.length) return;
    const report = addFilesWithReport(stagedRef.current, incoming);
    report.errors.forEach((e) => toast(e));
    if (!report.added.length) return;
    const prepared = new Map(report.added.map((f) => [f.id, makePreview(f)]));
    setStagedFiles(report.files.map((f) => prepared.get(f.id) ?? f));
  }, [makePreview, setStagedFiles, toast]);
  const removeStaged = useCallback((file: StagedFile | string) => {
    const before = stagedRef.current;
    const next = removeFile(before, file);
    const kept = new Set(next.map((f) => f.id));
    revokePreviews(before.filter((f) => !kept.has(f.id)));
    setStagedFiles(next);
  }, [revokePreviews, setStagedFiles]);
  const clearStaged = useCallback(() => {
    revokePreviews(stagedRef.current);
    setStagedFiles([]);
  }, [revokePreviews, setStagedFiles]);

  useEffect(() => () => revokePreviews(stagedRef.current), [revokePreviews]);

  // initial history
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api()
      .call<ChatMessage[]>("msg:history", room.key)
      .then((list) => {
        if (!alive) return;
        setMsgs(dedupeByMessageId(list));
        setHasMore(list.length >= 40);
        stickBottom.current = true;
      })
      .catch((e) => toast(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [room.key, toast]);

  // group room members (mentions + popup), cached per room
  useEffect(() => {
    let alive = true;
    setRoomMembers([]);
    if (!isGroupRoom) return () => { alive = false; };
    loadRoomMembers(room.key).then((list) => { if (alive) setRoomMembers(list); });
    return () => { alive = false; };
  }, [room.key, isGroupRoom]);

  // 유비온봇 자율활동: only group rooms the bot is a member of; default OFF until GET resolves.
  useEffect(() => {
    let alive = true;
    setBotAutonomy(false);
    setBotError("");
    setBotDisabled(false);
    if (!botRoom) {
      setBotLoading(false);
      return () => { alive = false; };
    }
    setBotLoading(true);
    api()
      .call<BotSettingsResult>("bot:roomSettings:get", room.key)
      .then((r) => {
        if (!alive) return;
        if (r.ok) {
          setBotAutonomy(r.settings.autonomy);
        } else {
          setBotAutonomy(false);
          setBotError(r.message);
          setBotDisabled(r.kind === "auth" || r.kind === "forbidden" || r.kind === "unavailable");
        }
      })
      .catch((e) => {
        if (!alive) return;
        setBotError((e as Error).message);
      })
      .finally(() => { if (alive) setBotLoading(false); });
    return () => { alive = false; };
  }, [room.key, botRoom]);

  const notice = room.notice;
  const noticeKey = notice?.messageId != null ? noticeStoreKey(notice.messageId) : "";
  useEffect(() => {
    setNoticeStatus(noticeKey ? normalizeNoticeStatus(localStorage.getItem(noticeKey)) : "normal");
  }, [noticeKey, room.noticeUpdatedAt]);
  const changeNoticeStatus = useCallback((status: NoticeStatus) => {
    if (noticeKey) localStorage.setItem(noticeKey, status);
    setNoticeStatus(status);
  }, [noticeKey]);

  // realtime
  useEffect(() => {
    const h = (ev: Event) => {
      const { type, payload } = (ev as CustomEvent).detail;
      if (type === "message" && payload.roomKey === room.key) {
        if (payload.attachUpdate) {
          // attach fill-in: replace the existing card only (never append), keep scroll position
          const { attachUpdate: _u, ...upd } = payload;
          setMsgs((l) => (l.some((x) => x.messageId === upd.messageId) ? upsertMessage(l, upd) : l));
        } else {
          const el = listRef.current;
          stickBottom.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120 || payload.isMine;
          setMsgs((l) => upsertMessage(l, payload));
        }
      } else if (type === "confirm" && payload.roomKey === room.key) {
        setMsgs((l) => applyReadReceipt(l, payload));
      } else if (type === "receipts" && payload.roomKey === room.key) {
        setMsgs((l) => mergeReceipts(l, payload.updates));
      } else if (type === "roomNotice" && payload.roomKey === room.key) {
        const key = payload.notice?.messageId != null ? noticeStoreKey(payload.notice.messageId) : "";
        if (key) localStorage.setItem(key, "normal");
        setNoticeStatus("normal");
      }
    };
    window.addEventListener("ubion:event", h);
    return () => window.removeEventListener("ubion:event", h);
  }, [room.key]);

  // mark read only while room is open AND window focused AND visible
  const lastId = [...msgs].reverse().find((m) => m.messageId != null)?.messageId;
  useEffect(() => {
    if (!focused || document.hidden || !lastId) return;
    if (lastReadSent.current >= lastId && !room.unread) return;
    lastReadSent.current = lastId;
    api().call("msg:markRead", room.key, lastId).catch(() => undefined);
  }, [focused, lastId, room.key, room.unread]);

  // scroll management
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (prevHeight.current != null) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
    } else if (stickBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [msgs, botStatus?.at]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore || loading) return;
    const first = msgs.find((m) => m.messageId != null)?.messageId;
    if (!first) return;
    setLoadingOlder(true);
    try {
      const older = await api().call<ChatMessage[]>("msg:history", room.key, first);
      if (older.length < 40) setHasMore(false);
      if (older.length) {
        prevHeight.current = listRef.current?.scrollHeight ?? null;
        setMsgs((l) => dedupeByMessageId([...older, ...l]));
      }
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, hasMore, loading, msgs, room.key, toast]);

  const onScroll = () => {
    const el = listRef.current!;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 150) void loadOlder();
  };

  const sendText = async (text: string) => {
    const clientId = `c${Date.now()}${Math.random()}`;
    const optimistic: ChatMessage = {
      clientId, message: text, sendUserSeq: me.id, sendUserName: me.name, userImage: me.thumbnail || "",
      createdAt: new Date().toISOString(), pending: true, confirmUsers: [],
      needConfirmCount: room.kind === "room" ? Math.max(0, (room.memberCount || 1) - 1) : room.kind === "buddy" && !room.isSelf ? 1 : 0,
    };
    stickBottom.current = true;
    setMsgs((l) => [...l, optimistic]);
    try {
      const r = await api().call<{ messageId?: number }>("msg:send", room.key, text);
      setMsgs((l) => upsertMessage(l, { ...optimistic, messageId: r.messageId, pending: false }));
    } catch (e) {
      setMsgs((l) => l.map((m) => (m.clientId === clientId ? { ...m, pending: false, failed: true } : m)));
      toast(t("전송 실패: {error}", { error: (e as Error).message }));
    }
  };

  const retry = (m: ChatMessage) => {
    setMsgs((l) => l.filter((x) => x.clientId !== m.clientId));
    void sendText(m.message);
  };

  const deletable = me.isMessageDeletable !== false;
  const requestDelete = (m: ChatMessage) => {
    if (!deletable || !canDeleteMessage(m, me.id)) return;
    setConfirmDelete(m);
  };
  const requestNotice = (m: ChatMessage) => {
    if (m.messageId == null || isDeletedMessage(m) || m.pending || m.failed) return;
    setConfirmNotice(m);
  };
  const saveMessage = async (m: ChatMessage) => {
    try {
      await api().saved.add({
        roomKey: room.key, roomName: room.name, messageId: m.messageId, message: m.message,
        sendUserName: m.sendUserName, createdAt: m.createdAt,
      });
      toast(t("메시지를 저장했습니다"), "info");
    } catch (e) {
      toast(t("메시지를 저장하지 못했습니다: {error}", { error: (e as Error).message }));
    }
  };
  const setReminder = async (m: ChatMessage, preset: ReminderPreset, customAt?: number) => {
    setRemindTarget(null);
    try {
      await api().reminders.add({
        roomKey: room.key, roomName: room.name, messageId: m.messageId, message: m.message,
        sendUserName: m.sendUserName, createdAt: m.createdAt, preset, customAt,
      });
      toast(t("알림이 설정되었습니다"), "info");
    } catch (e) {
      toast(t("알림을 설정하지 못했습니다: {error}", { error: (e as Error).message }));
    }
  };
  const doRegisterNotice = async () => {
    const target = confirmNotice;
    if (!target?.messageId) return;
    setConfirmNotice(null);
    try {
      await api().registerNotice(room.key, target.messageId);
      toast(t("공지를 등록했습니다"), "info");
    } catch (e) {
      toast(t("공지를 등록하지 못했습니다: {error}", { error: (e as Error).message }));
    }
  };
  const doDelete = async () => {
    const target = confirmDelete;
    if (!target?.messageId) return;
    setConfirmDelete(null);
    const ids = [target.messageId];
    const wasNotice = room.notice?.messageId === target.messageId;
    const snapshot = msgs.find((m) => m.messageId === target.messageId);
    setMsgs((l) => applyChatDelete(l, ids));
    try {
      await api().deleteChatMessages(ids);
      if (wasNotice) void api().registerNotice(room.key, target.messageId).catch(() => undefined);
      toast(t("메시지를 삭제했습니다"), "info");
    } catch (e) {
      if (snapshot) setMsgs((l) => l.map((m) => (m.messageId === target.messageId ? snapshot : m)));
      toast(t("삭제하지 못했습니다: {error}", { error: (e as Error).message }));
    }
  };

  const sendStagedFile = async (file: StagedFile): Promise<boolean> => {
    try {
      if (file.path) {
        await api().call("files:sendPaths", room.key, [file.path]);
      } else if (file.file instanceof Blob) {
        await api().call("files:sendBuffer", room.key, file.name, await file.file.arrayBuffer(), file.type);
      } else {
        throw new Error(t("파일을 읽을 수 없습니다"));
      }
      return true;
    } catch (e) {
      toast(t("업로드 실패: {error}", { error: (e as Error).message }));
      return false;
    }
  };

  const runSend = async (text: string): Promise<boolean> => {
    const before = stagedRef.current;
    const plan = sendPlan(before, text);
    if (!plan.length) return false;
    const fileCount = plan.filter((step) => step.type === "file").length;
    if (fileCount > 0) setUploading(fileCount);
    const outcome = await executeSendPlan(
      plan,
      sendStagedFile,
      sendText,
      () => setUploading((n) => Math.max(0, n - 1)),
    );
    if (fileCount > 0) {
      const succeeded = new Set<StagedFile>(outcome.succeeded);
      const remaining = stagedRef.current.filter((file) => !succeeded.has(file));
      revokePreviews(outcome.succeeded);
      setStagedFiles(mergeStaged(remaining, outcome.failed));
    }
    return outcome.failed.length > 0;
  };

  const sendQueue = useRef<Promise<unknown>>(Promise.resolve());
  const sendAll = (text: string): Promise<boolean> => {
    const run = sendQueue.current.then(() => runSend(text));
    sendQueue.current = run.catch(() => undefined);
    return run;
  };

  const pickStaged = async () => {
    try {
      const picked = await api().call<PickedStagingResult>("files:pickForStaging");
      picked.errors.forEach((e) => toast(e));
      stageFiles(picked.files.map((p) => ({
        name: p.name, size: p.size, lastModified: p.lastModified, type: p.type,
        path: p.path, previewData: p.preview,
      })));
    } catch (e) {
      toast(t("파일을 선택하지 못했습니다: {error}", { error: (e as Error).message }));
    }
  };

  const capturing = useRef(false);
  const captureScreen = async () => {
    if (capturing.current) return;
    capturing.current = true;
    try {
      const shot = await api().captureScreen();
      if (!shot) return;
      const file = new File([shot.data], shot.name, { type: shot.type, lastModified: Date.now() });
      // Staged only: the user still has to press 보내기.
      stageFiles([{ name: file.name, size: file.size, lastModified: file.lastModified, type: file.type, file }]);
    } catch (e) {
      toast(t("화면 캡쳐 실패: {error}", { error: (e as Error).message }));
    } finally {
      capturing.current = false;
    }
  };

  useEffect(() => {
    let alive = true;
    api().zoom.caps().then((c) => { if (alive) setZoomCaps(c); }).catch(() => { if (alive) setZoomCaps(null); });
    return () => { alive = false; };
  }, []);

  // Zoom: create the meeting, then only put the join URL in the composer. The user presses 보내기.
  const startZoom = async () => {
    if (zoomBusy) return;
    const key = room.key;
    setZoomBusy(true);
    try {
      let r = await api().zoom.createMeeting(key);
      if ("needsConnect" in r) {
        const c = await api().zoom.connect(key);
        if (!c.connected) return toast(t("Zoom 연결을 완료하지 못했습니다"));
        r = await api().zoom.createMeeting(key);
        if ("needsConnect" in r) return toast(t("Zoom 인증에 실패했습니다"));
      }
      setComposerInsert({ roomKey: key, text: r.joinUrl, id: Date.now() });
      toast(t("Zoom 회의 링크를 입력창에 넣었습니다. 보내기를 눌러 공유하세요"), "info");
    } catch (e) {
      toast(t("Zoom 회의를 만들지 못했습니다: {error}", { error: (e as Error).message }));
    } finally {
      setZoomBusy(false);
    }
  };

  const stagePasted = (files: File[]) => {
    stageFiles(files.map((f) => ({
      name: f.name && f.name !== "image.png" ? f.name : `캡처_${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
      size: f.size, lastModified: f.lastModified, type: f.type, file: f,
    })));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const items = [...(e.dataTransfer.items || [])].filter((item) => item.kind === "file");
    const candidates = items.length
      ? items.map((item) => {
          const entry = item.webkitGetAsEntry?.();
          const file = item.getAsFile();
          return { name: entry?.name || file?.name || "폴더", isDirectory: !!entry?.isDirectory, file };
        })
      : [...e.dataTransfer.files].map((file) => ({ name: file.name, isDirectory: false, file }));
    const { files, folders } = splitDroppedFiles(candidates);
    const folderMessage = folderSkipMessage(folders.map((folder) => folder.name));
    if (folderMessage) toast(folderMessage);
    stageFiles(files.flatMap((entry) => {
      if (!entry.file) return [];
      const path = api().pathForFile(entry.file);
      return [{
        name: entry.file.name, size: entry.file.size, lastModified: entry.file.lastModified, type: entry.file.type,
        path: path || undefined, file: entry.file,
      }];
    }));
  };

  const escapeTray = useCallback(() => {
    if (!stagedRef.current.length) return false;
    clearStaged();
    return true;
  }, [clearStaged]);

  const canSend = room.kind !== "pubsub" && room.kind !== "unknown";
  const toggleBotAutonomy = async () => {
    if (botLoading || botSaving || botDisabled) return;
    const next = !botAutonomy;
    setBotAutonomy(next);
    setBotSaving(true);
    setBotError("");
    try {
      const r = await api().call<BotSettingsResult>("bot:roomSettings:set", room.key, next);
      if (!r.ok) {
        setBotAutonomy(!next);
        setBotError(r.message);
        setBotDisabled(r.kind === "auth" || r.kind === "forbidden" || r.kind === "unavailable");
      } else {
        setBotAutonomy(r.settings.autonomy);
      }
    } catch (e) {
      setBotAutonomy(!next);
      setBotError((e as Error).message);
    } finally {
      setBotSaving(false);
    }
  };
  const toggleRoomPush = async () => {
    const next = !room.usePush;
    setRoomMenu(null);
    try {
      await api().setRoomPush(room.key, next);
      toast(next ? t("이 대화방의 알림을 켰습니다") : t("이 대화방의 알림을 껐습니다"), "info");
    } catch (e) {
      toast(t("알림 설정을 변경하지 못했습니다: {error}", { error: (e as Error).message }));
    }
  };
  const lastMine = [...msgs].reverse().find((m) => m.sendUserSeq === me.id && !m.pending && !m.failed);
  const subtitle =
    room.kind === "buddy"
      ? [room.position, t(presence ? PRES_LABEL[presence] : PRES_LABEL.offline)].filter(Boolean).join(" · ")
      : room.kind === "room"
      ? (room.memberCount ? t("그룹 대화 · {n}명", { n: room.memberCount }) : t("그룹 대화"))
      : t("알림 채널");

  const statusAuthor = botStatus ? roomMembers.find((m) => m.userId === botStatus.userId) : undefined;
  const statusMsg = botStatus ? [...msgs].reverse().find((m) => m.sendUserSeq === botStatus.userId) : undefined;
  const statusName =
    statusMsg?.sendUserName || statusAuthor?.name ||
    (botStatus && room.peerUserId === botStatus.userId ? room.name : "") ||
    (botStatus ? String(botStatus.userId) : "");
  const statusImage =
    statusMsg?.userImage || statusAuthor?.image ||
    (botStatus && room.peerUserId === botStatus.userId ? room.avatar : "") || "";

  return (
    <section
      className={`chat ${dragOver ? "drag" : ""}`}
      onDragOver={(e) => { if (canSend) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={canSend ? onDrop : undefined}
    >
      <header className="chat-head">
        <Avatar name={room.name} src={room.avatar} size={34} presence={room.peerUserId ? presence || "offline" : undefined} />
        <div className="chat-title">
          <div className="name">{room.name}</div>
          <div className="sub muted">{subtitle}</div>
        </div>
        {zoomCaps?.enabled && canSend && (
          <button className="icon-btn" title={t("Zoom 화상회의")} aria-label={t("Zoom 화상회의")} disabled={zoomBusy} onClick={() => void startZoom()}>
            <Icon name="video" size={18} />
          </button>
        )}
        <button className={`icon-btn ${searchOpen ? "on" : ""}`} title={t("대화 내용 검색")} onClick={() => setSearchOpen((s) => !s)}>
          <Icon name="search" size={18} />
        </button>
        <button
          className={`icon-btn ${roomMenu ? "on" : ""}`}
          title={t("대화방 메뉴")}
          onClick={(e) => {
            if (roomMenu) return setRoomMenu(null);
            const r = e.currentTarget.getBoundingClientRect();
            setRoomMenu({ x: Math.max(8, Math.min(r.right - 170, window.innerWidth - 178)), y: r.bottom + 4 });
          }}
        >
          <Icon name="more" size={18} />
        </button>
      </header>
      {notice && isNoticeVisible(notice, noticeStatus) && (
        <div className="banner info" style={{ justifyContent: "flex-start", gap: 8 }}>
          <span aria-hidden>📢</span>
          <button
            className="link"
            style={{
              flex: 1, minWidth: 0, textAlign: "left", overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: noticeStatus === "folded" ? "nowrap" : "normal",
            }}
            title={noticeText(notice)}
            onClick={() => changeNoticeStatus("normal")}
          >
            <b>{notice.sendUserName || t("공지")}</b> {noticeText(notice)}
          </button>
          {noticeStatus === "folded" ? (
            <button className="link tiny" onClick={() => changeNoticeStatus("normal")}>{t("펼치기")}</button>
          ) : (
            <button className="link tiny" onClick={() => changeNoticeStatus("folded")}>{t("접어두기")}</button>
          )}
          <button
            className="link tiny"
            onClick={() => { if (window.confirm(ROOM_NOTICE_CLOSE_CONFIRM)) changeNoticeStatus("closed"); }}
          >
            {t("다시 보지 않음")}
          </button>
        </div>
      )}
      <div className="chat-body">
        <div className="msg-list" ref={listRef} onScroll={onScroll}>
          {loadingOlder && <div className="loader-line">{t("이전 메시지 불러오는 중…")}</div>}
          {!hasMore && !loading && <div className="history-start muted">{t("대화의 시작입니다")}</div>}
          {loading ? (
            <div className="skeletons">{Array.from({ length: 6 }, (_, i) => <div key={i} className={`sk ${i % 2 ? "r" : ""}`} />)}</div>
          ) : (
            msgs.map((m, i) => {
              const prev = msgs[i - 1];
              const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
              const mine = m.sendUserSeq === me.id;
              const grouped =
                !newDay && prev && prev.sendUserSeq === m.sendUserSeq &&
                Math.abs((parseTime(m.createdAt)?.getTime() || 0) - (parseTime(prev.createdAt)?.getTime() || 0)) < 5 * 60_000;
              const next = msgs[i + 1];
              const showTime = !next || next.sendUserSeq !== m.sendUserSeq || timeLabel(next.createdAt) !== timeLabel(m.createdAt);
              return (
                <Fragment key={m.messageId ?? m.clientId ?? i}>
                  {newDay && <div className="day-sep"><span>{dayLabel(m.createdAt)}</span></div>}
                  <MessageRow
                    m={m} mine={mine} grouped={!!grouped} showTime={showTime} room={room} meId={me.id}
                    isLastMine={m === lastMine} memberNames={memberNames} myName={me.name}
                    onImage={() => setViewer(m)} onRetry={() => retry(m)} toast={toast}
                    onDelete={deletable && canDeleteMessage(m, me.id) ? () => requestDelete(m) : undefined}
                    onNotice={!isDeletedMessage(m) && !m.pending && !m.failed && m.messageId != null ? () => requestNotice(m) : undefined}
                    onSave={!isDeletedMessage(m) && !m.pending && !m.failed ? () => void saveMessage(m) : undefined}
                    onRemind={!isDeletedMessage(m) && !m.pending && !m.failed ? () => setRemindTarget(m) : undefined}
                  />
                </Fragment>
              );
            })
          )}
          <div aria-live="polite">
          {!loading && botStatus && (
            <div className="msg bot-status">
              <div className="msg-av"><Avatar name={statusName} src={statusImage} size={34} /></div>
              <div className="msg-main">
                {statusName && <div className="msg-name">{statusName}</div>}
                <div className="msg-line">
                  <div className="bubble bot-status-bubble">
                    <span className="bot-status-text">{t(botStatusLabel(botStatus.state, botStatus.text))}</span>
                    <span className="bot-status-dots" aria-hidden="true"><i /><i /><i /></span>
                  </div>
                </div>
              </div>
            </div>
          )}
          </div>
        </div>
        {searchOpen && <SearchPanel room={room} onClose={() => setSearchOpen(false)} />}
      </div>
      {uploading > 0 && <div className="upload-bar">{t("파일 {n}개 업로드 중…", { n: uploading })}</div>}
      {canSend ? (
        <>
          {staged.length > 0 && (
            <div
              className="attach-tray"
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                if (escapeTray()) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
            >
              {staged.map((f) => (
                <div className="attach-chip" key={f.id} tabIndex={0}>
                  {f.previewUrl ? (
                    <img className="attach-thumb" src={f.previewUrl} alt="" />
                  ) : (
                    <span className="attach-ic"><Icon name={isImageFile(f) ? "image" : "file"} size={16} /></span>
                  )}
                  <div className="attach-info">
                    <span className="attach-name" title={f.name}>{f.name}</span>
                    <span className="attach-size muted">{formatSize(f.size)}</span>
                  </div>
                  <button className="attach-remove" title={t("첨부 취소")} onClick={() => removeStaged(f)}>
                    <Icon name="close" size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <Composer
            roomKey={room.key} meId={me.id} isGroup={isGroupRoom}
            hasFiles={staged.length > 0}
            onSend={sendAll}
            onPick={() => void pickStaged()}
            onCapture={() => void captureScreen()}
            onPasteFiles={stagePasted}
            onEscapeTray={escapeTray}
            insert={composerInsert}
          />
        </>
      ) : (
        <div className="composer readonly muted">{t("이 채널은 읽기 전용입니다")}</div>
      )}
      {dragOver && <div className="drop-hint">{t("여기에 놓아 파일 보내기")}</div>}
      {viewer?.attach && <MediaViewer m={viewer} onClose={() => setViewer(null)} toast={toast} />}
      {roomMenu && (
        <RoomMenu
          x={roomMenu.x} y={roomMenu.y} usePush={room.usePush}
          onToggle={() => void toggleRoomPush()} onClose={() => setRoomMenu(null)}
          onBackup={room.kind !== "pubsub" ? () => setBackupOpen(true) : undefined}
          showBot={botRoom} botAutonomy={botAutonomy} botBusy={botLoading || botSaving}
          botDisabled={botDisabled} botError={botError} onToggleBot={() => void toggleBotAutonomy()}
        />
      )}
      {backupOpen && (
        <BackupModal
          room={room} toast={toast} onClose={() => setBackupOpen(false)}
          lastMessageId={[...msgs].reverse().find((m) => m.messageId != null && !m.pending && !m.failed)?.messageId}
          onHistoryCleared={() => setMsgs([])}
        />
      )}
      {confirmDelete && (
        <div className="modal-back" onClick={() => setConfirmDelete(null)}>
          <div className="modal compose-discard" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="modal-body">
              <p>{CHAT_DELETE_CONFIRM}</p>
              <div className="approval-modal-actions">
                <button className="link" onClick={() => setConfirmDelete(null)}>{t("취소")}</button>
                <button className="danger-btn" autoFocus onClick={() => void doDelete()}>{t("삭제")}</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {confirmNotice && (
        <div className="modal-back" onClick={() => setConfirmNotice(null)}>
          <div className="modal compose-discard" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="modal-body">
              <p>{ROOM_NOTICE_REGISTER_CONFIRM}</p>
              <div className="approval-modal-actions">
                <button className="link" onClick={() => setConfirmNotice(null)}>{t("취소")}</button>
                <button className="primary" autoFocus onClick={() => void doRegisterNotice()}>{t("공지로 등록")}</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {remindTarget && (
        <ReminderModal m={remindTarget} onPick={(p, c) => void setReminder(remindTarget, p, c)} onClose={() => setRemindTarget(null)} />
      )}
    </section>
  );
}

function Linkified({ text, memberNames = [], myName = "" }: { text: string; memberNames?: string[]; myName?: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <a key={i} href={p} onClick={(e) => { e.preventDefault(); api().call("app:openExternal", p); }}>{p}</a>
        ) : DAOU_STICKERS_ENABLED ? (
          <Fragment key={i}>
            {parseEmoticonCodes(p).map((seg, j) =>
              seg.type === "sticker" ? (
                <StickerImage key={j} src={seg.src} code={seg.value} />
              ) : (
                <MentionedText key={j} text={seg.value} memberNames={memberNames} myName={myName} />
              )
            )}
          </Fragment>
        ) : (
          <MentionedText key={i} text={p} memberNames={memberNames} myName={myName} />
        )
      )}
    </>
  );
}

/** DaouOffice sticker (flagged off). Falls back to the raw "(name)" code if the asset is missing. */
function StickerImage({ src, code }: { src: string; code: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <>{code}</>;
  return <img className="sticker" src={src} alt={code} title={code} draggable={false} onError={() => setBroken(true)} />;
}

function MentionedText({ text, memberNames, myName }: { text: string; memberNames: string[]; myName: string }) {
  if (!memberNames.length) return <>{text}</>;
  return (
    <>
      {parseMentionTokens(text, memberNames).map((seg, i) =>
        seg.type === "mention" ? (
          <span key={i} className={`mention${seg.name === myName ? " mention-me" : ""}`}>{seg.value}</span>
        ) : (
          <Fragment key={i}>{seg.value}</Fragment>
        )
      )}
    </>
  );
}

function RoomMenu({
  x, y, usePush, onToggle, onClose, onBackup,
  showBot, botAutonomy, botBusy, botDisabled, botError, onToggleBot,
}: {
  x: number; y: number; usePush: boolean; onToggle: () => void; onClose: () => void; onBackup?: () => void;
  showBot: boolean; botAutonomy: boolean; botBusy: boolean; botDisabled: boolean;
  botError: string; onToggleBot: () => void;
}) {
  const t = useT();
  useEffect(() => {
    const h = (e: Event) => { if (e instanceof KeyboardEvent && e.key !== "Escape") return; onClose(); };
    window.addEventListener("mousedown", h); window.addEventListener("keydown", h); window.addEventListener("blur", h);
    return () => { window.removeEventListener("mousedown", h); window.removeEventListener("keydown", h); window.removeEventListener("blur", h); };
  }, [onClose]);
  return (
    <div className="ctx-menu" role="menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      <button role="menuitem" onClick={() => { onClose(); onToggle(); }}>
        <Icon name={usePush ? "bellOff" : "bell"} size={14} /> {usePush ? t("알림 끄기") : t("알림 켜기")}
      </button>
      {onBackup && (
        <button role="menuitem" onClick={() => { onClose(); onBackup(); }}>
          <Icon name="download" size={14} /> {t("대화 백업")}
        </button>
      )}
      {showBot && (
        <div className="bot-autonomy">
          <label className="bot-autonomy-row">
            <span>
              <span className="bot-autonomy-title">{t("유비온봇 자율활동")}</span>
              <span className="muted tiny bot-autonomy-desc">{t("켜면 유비온봇이 호출 없이도 대화 흐름을 보고 참여할 수 있습니다.")}</span>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={botAutonomy}
              disabled={botBusy || botDisabled}
              aria-label={t("유비온봇 자율활동")}
              onChange={onToggleBot}
            />
          </label>
          {botBusy && <div className="muted tiny">{t("불러오는 중…")}</div>}
          {botError && <div className="bot-autonomy-error">{botError}</div>}
        </div>
      )}
    </div>
  );
}

function MessageMenu({
  x, y, onDelete, onNotice, onSave, onRemind, onClose,
}: { x: number; y: number; onDelete?: () => void; onNotice?: () => void; onSave?: () => void; onRemind?: () => void; onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const h = (e: Event) => { if (e instanceof KeyboardEvent && e.key !== "Escape") return; onClose(); };
    window.addEventListener("mousedown", h); window.addEventListener("keydown", h); window.addEventListener("blur", h);
    return () => { window.removeEventListener("mousedown", h); window.removeEventListener("keydown", h); window.removeEventListener("blur", h); };
  }, [onClose]);
  return (
    <div className="ctx-menu" role="menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      {onSave && <button role="menuitem" onClick={() => { onClose(); onSave(); }}><Icon name="star" size={14} /> {t("저장")}</button>}
      {onRemind && <button role="menuitem" onClick={() => { onClose(); onRemind(); }}><Icon name="clock" size={14} /> {t("나중에 알림")}</button>}
      {onNotice && <button role="menuitem" onClick={() => { onClose(); onNotice(); }}><Icon name="report" size={14} /> {t("공지로 등록")}</button>}
      {onDelete && <button role="menuitem" className="danger" onClick={() => { onClose(); onDelete(); }}><Icon name="trash" size={14} /> {t("삭제")}</button>}
    </div>
  );
}

function ReminderModal({ m, onPick, onClose }: {
  m: ChatMessage; onPick: (preset: ReminderPreset, customAt?: number) => void; onClose: () => void;
}) {
  const t = useT();
  const [showCustom, setShowCustom] = useState(false);
  const [custom, setCustom] = useState("");
  const now = new Date();
  const minLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const submitCustom = () => {
    if (!custom) return;
    const at = new Date(custom).getTime();
    if (Number.isNaN(at)) return;
    onPick("custom", at);
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal compose-discard" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-body">
          <p className="muted small">{t("나중에 알림")}</p>
          <p className="reminder-snippet">{m.message || t("(내용 없음)")}</p>
          {!showCustom ? (
            <div className="reminder-presets">
              {REMINDER_PRESETS.filter((p) => p.id !== "custom").map((p) => (
                <button key={p.id} className="primary" onClick={() => onPick(p.id)}>{t(p.label)}</button>
              ))}
              <button className="link" onClick={() => setShowCustom(true)}>{t("사용자 지정")}</button>
            </div>
          ) : (
            <div className="reminder-custom">
              <input
                type="datetime-local"
                min={minLocal(now)}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
              />
              <div className="approval-modal-actions">
                <button className="link" onClick={() => setShowCustom(false)}>{t("취소")}</button>
                <button className="primary" disabled={!custom} onClick={submitCustom}>{t("설정")}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageRow({
  m, mine, grouped, showTime, room, meId, isLastMine, memberNames, myName, onImage, onRetry, toast, onDelete, onNotice, onSave, onRemind,
}: {
  m: ChatMessage; mine: boolean; grouped: boolean; showTime: boolean; room: Room; meId: number; isLastMine: boolean;
  memberNames: string[]; myName: string;
  onImage: () => void; onRetry: () => void; toast: ToastFn; onDelete?: () => void; onNotice?: () => void;
  onSave?: () => void; onRemind?: () => void;
}) {
  const t = useT();
  const deleted = isDeletedMessage(m);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const openMenu = (e: React.MouseEvent) => {
    if ((!onDelete && !onNotice && !onSave && !onRemind) || deleted) return;
    e.preventDefault();
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 170), y: Math.min(e.clientY, window.innerHeight - 110) });
  };
  // SENDFILE without an attach model (seen as "filename only" text): still render a (disabled) file card.
  const a = m.attach ?? (m.messageType === "SENDFILE" && m.message ? { cryptId: "", name: m.message }
    : m.messageType === "DELETEDFILE" ? { cryptId: "", name: m.message || t("삭제된 파일"), expired: true } : undefined);
  return (
    <div className={`msg ${mine ? "mine" : ""} ${grouped ? "grouped" : ""}`}>
      {menu && (onDelete || onNotice || onSave || onRemind) && (
        <MessageMenu x={menu.x} y={menu.y} onDelete={onDelete} onNotice={onNotice} onSave={onSave} onRemind={onRemind} onClose={() => setMenu(null)} />
      )}
      {!mine && <div className="msg-av">{!grouped && <Avatar name={m.sendUserName} src={m.userImage} size={34} />}</div>}
      <div className="msg-main">
        {!mine && !grouped && <div className="msg-name">{m.sendUserName}</div>}
        <div className="msg-line">
          {deleted ? (
            <div className="bubble deleted">{CHAT_DELETED_PLACEHOLDER}</div>
          ) : a ? (
            <FileCard m={a === m.attach ? m : { ...m, attach: a }} mine={mine} onOpenMedia={onImage} toast={toast}
              canDelete={!!onDelete} onDelete={onDelete} canNotice={!!onNotice} onNotice={onNotice} />
          ) : (
            <div className="bubble-col">
              <div className="bubble" onContextMenu={openMenu}>
                <Linkified text={m.message} memberNames={memberNames} myName={myName} />
              </div>
              {!m.pending && <LinkPreview text={m.message} />}
            </div>
          )}
          <div className="msg-meta">
            {m.failed ? (
              <button className="link danger tiny" onClick={onRetry}>{t("전송 실패 · 재시도")}</button>
            ) : m.pending ? (
              <span className="tiny muted">{t("전송 중…")}</span>
            ) : (
              <>
                <ReadMark m={m} room={room} meId={meId} mine={mine} isLastMine={isLastMine} />
                {showTime && <span className="tiny muted">{timeLabel(m.createdAt)}</span>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

type ComposerInsert = { roomKey: string; text: string; id: number };

function Composer({
  roomKey, meId, isGroup, hasFiles, onSend, onPick, onCapture, onPasteFiles, onEscapeTray, insert,
}: {
  roomKey: string; meId: number; isGroup: boolean; hasFiles: boolean;
  onSend: (t: string) => Promise<boolean>; onPick: () => void; onCapture: () => void; onPasteFiles: (files: File[]) => void;
  onEscapeTray: () => boolean; insert?: ComposerInsert | null;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const [members, setMembers] = useState<MentionCandidate[]>([]);
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
  const [cursorEnd, setCursorEnd] = useState(0);
  const [active, setActive] = useState(0);
  const composing = useRef(false);
  const sending = useRef(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const drafts = useRef<Record<string, string>>({});
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [recentEmoji, setRecentEmoji] = useState<string[]>(() => loadRecentEmoji());
  const emojiBtn = useRef<HTMLButtonElement>(null);
  const closeEmoji = useCallback(() => setEmojiOpen(false), []);

  // Insert at the caret as plain text (safe wire format). Picker stays open for multiple picks.
  const pickEmoji = (emoji: string) => {
    const el = ta.current;
    const current = el?.value ?? text;
    const next = insertAtSelection(current, el?.selectionStart ?? current.length, el?.selectionEnd ?? current.length, emoji);
    setText(next.text);
    setTrigger(null);
    setRecentEmoji((list) => {
      const updated = pushRecentEmoji(list, emoji);
      saveRecentEmoji(updated);
      return updated;
    });
    requestAnimationFrame(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.cursor, next.cursor);
    });
  };

  useEffect(() => {
    setText(drafts.current[roomKey] || "");
    setTrigger(null);
    setEmojiOpen(false);
    ta.current?.focus();
  }, [roomKey]);

  // External text (Zoom join URL) goes in at the caret; never sent automatically.
  useEffect(() => {
    if (!insert || insert.roomKey !== roomKey) return;
    const el = ta.current;
    const current = el?.value ?? "";
    const next = insertAtSelection(current, el?.selectionStart ?? current.length, el?.selectionEnd ?? current.length, insert.text);
    setText(next.text);
    requestAnimationFrame(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.cursor, next.cursor);
    });
  }, [insert?.id]);

  useEffect(() => {
    let alive = true;
    setMembers([]);
    setTrigger(null);
    if (!isGroup) return () => { alive = false; };
    loadRoomMembers(roomKey).then((list) => { if (alive) setMembers(list); });
    return () => { alive = false; };
  }, [roomKey, isGroup]);

  useEffect(() => {
    drafts.current[roomKey] = text;
    const el = ta.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  }, [text, roomKey]);

  const suggestions = trigger && isGroup ? filterMembers(members, trigger.query, meId) : [];
  const open = !!trigger && suggestions.length > 0;
  const safeActive = suggestions.length ? Math.min(active, suggestions.length - 1) : 0;

  const syncTrigger = (value: string, pos: number) => {
    if (!isGroup) {
      setTrigger(null);
      return;
    }
    setTrigger(findMentionTrigger(value, pos));
    setCursorEnd(pos);
    setActive(0);
  };

  const pick = (member: MentionCandidate) => {
    if (!trigger) return;
    const current = ta.current?.value ?? text;
    const next = insertMention(current, trigger, cursorEnd, member.name);
    setText(next.text);
    setTrigger(null);
    requestAnimationFrame(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const submit = () => {
    if (sending.current) return;
    const original = text;
    const trimmed = original.replace(/\s+$/, "");
    if (!trimmed.trim() && !hasFiles) return;
    sending.current = true;
    setTrigger(null);
    void (async () => {
      try {
        const failed = await onSend(trimmed);
        if (!failed) setText((current) => (current === original ? "" : current));
      } finally {
        sending.current = false;
      }
    })();
  };

  return (
    <div className="composer">
      {open && (
        <div className="mention-pop" role="listbox" aria-label={t("멘션할 멤버")}>
          {suggestions.map((member, i) => (
            <button
              key={member.userId}
              type="button"
              role="option"
              aria-selected={i === safeActive}
              className={`mention-item${i === safeActive ? " on" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(ev) => { ev.preventDefault(); pick(member); }}
            >
              <Avatar name={member.name} src={member.image} size={28} />
              <span className="mention-name">{member.name}</span>
              {member.position && <span className="mention-pos muted">{member.position}</span>}
            </button>
          ))}
        </div>
      )}
      <button className="icon-btn" title={t("파일 첨부")} onClick={onPick}><Icon name="clip" /></button>
      <button className="icon-btn" title={t("화면 캡쳐")} aria-label={t("화면 캡쳐")} onClick={onCapture}><Icon name="capture" /></button>
      <button ref={emojiBtn} className={`icon-btn${emojiOpen ? " on" : ""}`} title={t("이모티콘")} aria-label={t("이모티콘")}
        aria-expanded={emojiOpen} onClick={() => setEmojiOpen((v) => !v)}><Icon name="smile" /></button>
      {emojiOpen && <EmojiPicker recent={recentEmoji} anchor={emojiBtn} onPick={pickEmoji} onClose={closeEmoji} />}
      <textarea
        ref={ta}
        rows={1}
        value={text}
        placeholder={t("메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)")}
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          syncTrigger(value, e.target.selectionStart ?? value.length);
        }}
        onSelect={(e) => {
          const el = e.currentTarget;
          syncTrigger(el.value, el.selectionStart ?? el.value.length);
        }}
        onBlur={() => setTrigger(null)}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => (composing.current = false)}
        onKeyDown={(e) => {
          const native = e.nativeEvent as KeyboardEvent;
          const ime = !!native.isComposing || native.keyCode === 229 || composing.current;
          if (!ime && open) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => (i + 1) % suggestions.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
              return;
            }
            if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
              e.preventDefault();
              pick(suggestions[safeActive]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setTrigger(null);
              return;
            }
          }
          if (!ime && e.key === "Escape") {
            if (onEscapeTray()) {
              e.preventDefault();
              return;
            }
          }
          if (e.key !== "Enter") return;
          if (isSendEnter({ key: e.key, shiftKey: e.shiftKey, isComposing: native.isComposing, keyCode: native.keyCode, composingRef: composing.current })) {
            e.preventDefault();
            submit();
          } else if (!e.shiftKey) {
            // Enter during IME composition: let the IME commit, never send
          }
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length) {
            e.preventDefault();
            onPasteFiles(files);
          }
        }}
      />
      <button className="send-btn" disabled={!text.trim() && !hasFiles} title={t("전송")} onClick={submit}><Icon name="send" size={18} /></button>
    </div>
  );
}

function SearchPanel({ room, onClose }: { room: Room; onClose: () => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<ChatMessage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    try {
      setRes(await api().call("msg:search", room.key, q.trim()));
    } catch {
      setRes([]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="search-panel">
      <div className="side-head">
        <h3>{t("대화 검색")}</h3>
        <button className="icon-btn" onClick={onClose}><Icon name="close" size={16} /></button>
      </div>
      <form className="search-box" onSubmit={run}>
        <Icon name="search" size={16} />
        <input autoFocus placeholder={t("검색어 입력 후 Enter")} value={q} onChange={(e) => setQ(e.target.value)} />
      </form>
      <div className="search-results">
        {busy && <div className="muted small pad">{t("검색 중…")}</div>}
        {res && !busy && !res.length && <div className="muted small pad">{t("결과 없음")}</div>}
        {res?.map((m) => (
          <div key={m.messageId} className="search-hit">
            <div className="small"><b>{m.sendUserName}</b> <span className="muted tiny">{dayLabel(m.createdAt)} {timeLabel(m.createdAt)}</span></div>
            <div className="small hit-text">{isDeletedMessage(m) ? CHAT_DELETED_PLACEHOLDER : m.message}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}

/**
 * Read receipt label, official semantics: unread member count (needConfirmCount) next to every message
 * while > 0, nothing for notice channels. Extra: subtle "읽음" under my latest 1:1 message once read.
 * Click opens who-read popover (group: member list from /api/chat/members).
 */
function ReadMark({ m, room, meId, mine, isLastMine }: { m: ChatMessage; room: Room; meId: number; mine: boolean; isLastMine: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (room.kind === "pubsub" || room.isSelf || m.messageId == null) return null;
  const n = m.needConfirmCount || 0;
  if (n <= 0) {
    return mine && isLastMine && room.kind === "buddy" ? <span className="read-done tiny">{t("읽음")}</span> : null;
  }
  return (
    <span className="read-wrap">
      <button
        className="unread-n"
        title={room.kind === "buddy" ? t("상대방이 아직 읽지 않았습니다") : t("{n}명이 읽지 않았습니다", { n })}
        onClick={(e) => { e.stopPropagation(); if (room.kind === "room") setOpen((o) => !o); }}
      >
        {n}
      </button>
      {open && <ReadersPopover m={m} room={room} meId={meId} onClose={() => setOpen(false)} />}
    </span>
  );
}

function ReadersPopover({ m, room, meId, onClose }: { m: ChatMessage; room: Room; meId: number; onClose: () => void }) {
  const t = useT();
  const [members, setMembers] = useState<{ userId: number; name: string; image: string }[] | null>(null);
  useEffect(() => {
    api().call("rooms:members", room.key).then(setMembers).catch(() => setMembers([]));
    const h = () => onClose();
    setTimeout(() => window.addEventListener("click", h), 0);
    return () => window.removeEventListener("click", h);
  }, [room.key, onClose]);
  const read = new Set(m.confirmUsers || []);
  const others = (members || []).filter((u) => u.userId !== m.sendUserSeq);
  const unreadList = others.filter((u) => !read.has(u.userId));
  const readList = others.filter((u) => read.has(u.userId));
  return (
    <div className="readers" onClick={(e) => e.stopPropagation()}>
      {!members ? (
        <div className="muted small">{t("불러오는 중…")}</div>
      ) : (
        <>
          <div className="readers-h">{t("안 읽음 {n}", { n: unreadList.length })}</div>
          {unreadList.map((u) => <div key={u.userId} className="readers-row"><Avatar name={u.name} src={u.image} size={20} />{u.name}{u.userId === meId ? ` ${t("(나)")}` : ""}</div>)}
          <div className="readers-h">{t("읽음 {n}", { n: readList.length })}</div>
          {readList.map((u) => <div key={u.userId} className="readers-row muted"><Avatar name={u.name} src={u.image} size={20} />{u.name}{u.userId === meId ? ` ${t("(나)")}` : ""}</div>)}
        </>
      )}
    </div>
  );
}
