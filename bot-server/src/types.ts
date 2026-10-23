export type BotRoom = { room_id: string; room_name: string; kind?: string; member_count?: number | null };
export type InboundMessage = {
  room_id: string; message_id: number; sender: { id: string; name: string }; text: string;
  mentions: string[]; attachments: { name: string; size?: number; type?: string; file_id?: string; image?: boolean }[]; reply_to: string | null; ts: string; is_mine: boolean;
  messageType?: string;
};
/** A downloadable inbound attachment, always exposed with a stable index and API URL. */
export type BotAttachment = { index: number; name: string; size: number | null; mime: string; file_id: string; image: boolean; url: string };
/** The only surface the bot server needs from DaouOffice; MessengerCore adapter or a mock implements it. */
export interface DaouPort {
  botUserId(): string | null;
  botName(): string;
  listRooms(): Promise<BotRoom[]>;
  sendText(room_id: string, text: string): Promise<{ message_id?: number }>;
  sendFile?(room_id: string, file: { name: string; data: Buffer; mime?: string }): Promise<{ message_id?: number }>;
  getAttachments?(room_id: string, message_id: number): Promise<Array<{ name: string; size?: number; mime?: string; file_id: string; image?: boolean }>>;
  downloadAttachment?(room_id: string, message_id: number, index: number): Promise<{ data: Buffer; contentType: string; name: string }>;
  onMessage(cb: (m: InboundMessage) => void): () => void;
  deleteMessages?(room_id: string, ids: number[]): Promise<void>;
  markRead?(room_id: string, message_id: number): Promise<void>;
  onRoomJoined(cb: (r: BotRoom) => void): () => void;
  healthy(): { state: string };
}
export type BotEvent =
  | { type: "message.created"; event_id: string; room_id: string; room_name: string; message_id: number; sender: { id: string; name: string }; text: string; mentions: string[]; attachments: BotAttachment[]; reply_to: string | null; ts: string }
  | { type: "room.joined"; event_id: string; room_id: string; room_name: string; ts: string }
  | { type: "conversation_idle"; event_id: string; room_id: string; room_name: string; message_count: number; first_message_id: number; last_message_id: number; started_at: string; ended_at: string; idle_minutes: number };
