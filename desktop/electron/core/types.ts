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
  confirmCount?: number;
  needConfirmCount?: number;
};

export type SessionUser = {
  id: number;
  repId: number;
  name: string;
  loginId: string;
  companyId?: number;
  thumbnail?: string;
  position?: string;
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
  confirm: { roomKey?: string; messageId?: number };
  presence: { userId: number; presence: Presence };
  connection: { state: ConnState; error?: string };
};
