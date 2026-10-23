import type { PortalEvents } from "./portal";
export type RoomKind = "buddy" | "room" | "pubsub" | "unknown";

export type Room = {
  key: string; // `${kind}:${seq}`
  kind: RoomKind;
  seq: number;
  name: string;
  preview: string;
  messageId?: number;
  unread: number;
  createdAt?: string;
  usePin: boolean;
  usePush: boolean;
  avatar: string;
  memberCount?: number;
  isSelf: boolean;
  peerUserId?: number; // buddy rooms
  position?: string;
};

export type AttachModel = {
  cryptId: string;
  name: string;
  extention?: string;
  size?: number;
  imageFile?: boolean;
  thumbSmall?: string;
  thumbMid?: string;
  thumbLarge?: string;
  thumbOriginal?: string;
  videoFile?: boolean;
  videoThumb?: string;
  duration?: number;
  width?: number;
  height?: number;
  /** ISO time after which the server no longer serves the file. */
  expiresAt?: string;
  expired?: boolean;
};

export type ChatMessage = {
  messageId?: number;
  clientId?: string;
  roomKey?: string;
  sendUserSeq?: number;
  sendUserName: string;
  targetUserSeq?: number;
  message: string;
  createdAt?: string;
  userImage: string;
  companyId?: number;
  messageType?: string;
  attach?: AttachModel;
  pending?: boolean;
  failed?: boolean;
  /** Server tombstone: the row stays, but text/attachments render as "삭제된 메시지입니다". */
  deleted?: boolean;
  confirmCount?: number;
  needConfirmCount?: number;
  /** userSeqs who have read this message (REST `confirmUsers`) */
  confirmUsers?: number[];
  /** Realtime file message re-emitted after REST filled in its attach; UI-only update. */
  attachUpdate?: boolean;
};

export type SessionUser = {
  id: number;
  repId: number;
  name: string;
  loginId: string;
  companyId?: number;
  thumbnail?: string;
  position?: string;
  /** /api/user/session brandName (DO_INSTALL | DO_SOLUTION | DO_SAAS). */
  brandName?: string;
  /** /api/user/session isMessageDeletable; undefined = allowed (older server). */
  isMessageDeletable?: boolean;
};

export type Person = {
  userId: number;
  name: string;
  position: string;
  email: string;
  thumbnail: string;
  departmentIds: number[];
  directTel?: string;
  mobileNo?: string;
};

export type Department = { id: number; name: string; sortOrder: number; parentId?: number; depth?: number; memberIds?: number[] };

export type Presence = "online" | "away" | "busy" | "offline";

export type LoginOptions = {
  serverUrl: string;
  username: string;
  password: string;
};

export type ConnState = "offline" | "connecting" | "online" | "reconnecting";

/** Events emitted by MessengerCore — stable surface for UI and future bot adapter. */
export type MessengerEventMap = {
  ready: SessionUser;
  loggedOut: { reason?: string };
  rooms: Room[];
  message: ChatMessage & { roomKey: string; roomKind: RoomKind; roomSeq: number; isMine: boolean; usePush: boolean };
  /** Someone (readerSeq) read messages of a room up to endId (XMPP type "confirm" or local mark-read). */
  confirm: ReadReceipt;
  /** Authoritative read counts from REST for the open room (sync fallback). */
  receipts: { roomKey: string; updates: Array<{ messageId: number; needConfirmCount: number; confirmUsers: number[] }> };
  presence: { userId: number; presence: Presence };
  connection: { state: ConnState; error?: string };
} & PortalEvents;

export type ReadReceipt = { roomKey: string; readerSeq: number; beginId?: number; endId?: number };

export type RoomMember = { userId: number; name: string; image: string; position: string };

/** OpenGraph link preview card data (fetched in main, rendered in chat). */
export type LinkPreview = {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  internal?: boolean;
};
