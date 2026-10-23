export type BotRoom = { room_id: string; room_name: string };
export type InboundMessage = {
  room_id: string; message_id: number; sender: { id: string; name: string }; text: string;
  mentions: string[]; attachments: { name: string; size?: number; type?: string }[]; reply_to: string | null; ts: string; is_mine: boolean;
};
/** The only surface the bot server needs from DaouOffice; MessengerCore adapter or a mock implements it. */
export interface DaouPort {
  botUserId(): string | null;
  botName(): string;
  listRooms(): Promise<BotRoom[]>;
  sendText(room_id: string, text: string): Promise<{ message_id?: number }>;
  onMessage(cb: (m: InboundMessage) => void): () => void;
  onRoomJoined(cb: (r: BotRoom) => void): () => void;
  healthy(): { state: string };
}
export type BotEvent =
  | { type: "message.created"; event_id: string; room_id: string; room_name: string; sender: { id: string; name: string }; text: string; mentions: string[]; attachments: InboundMessage["attachments"]; reply_to: string | null; ts: string }
  | { type: "room.joined"; event_id: string; room_id: string; room_name: string; ts: string };
