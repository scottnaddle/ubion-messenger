export type Room = {
  key: string;
  kind: "buddy" | "room" | "pubsub" | "unknown";
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
};

export type Message = {
  messageId?: number;
  clientId?: string;
  sendUserSeq?: number;
  sendUserName: string;
  targetUserSeq?: number;
  message: string;
  createdAt?: string;
  userImage: string;
  companyId?: number;
  messageType?: string;
  attach?: unknown;
  pending?: boolean;
  failed?: boolean;
};

export type Me = {
  id: number;
  name: string;
  loginId: string;
  companyId?: number;
  thumbnail?: string;
  position?: string;
  xmppConnected?: boolean;
};

export type Person = {
  userId: number;
  name: string;
  position: string;
  email: string;
  thumbnail: string;
  status: string;
};
