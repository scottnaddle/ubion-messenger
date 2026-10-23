import type { BotRoom, DaouPort, InboundMessage } from "./types";

/** Degraded DaouPort used when bot credentials are missing or placeholders. */
export class NotConfiguredPort implements DaouPort {
  botUserId(): string | null { return null; }
  botName(): string { return ""; }
  healthy(): { state: string } { return { state: "not_configured" }; }
  async listRooms(): Promise<BotRoom[]> { return []; }
  async sendText(_room_id: string, _text: string): Promise<{ message_id?: number }> {
    throw new Error("daou not configured");
  }
  async sendFile(_room_id: string, _file: { name: string; data: Buffer; mime?: string }): Promise<{ message_id?: number }> {
    throw new Error("daou not configured");
  }
  async deleteMessages(_room_id: string, _ids: number[]): Promise<void> { throw new Error("daou not configured"); }
  onMessage(_cb: (m: InboundMessage) => void): () => void { return () => {}; }
  onRoomJoined(_cb: (r: BotRoom) => void): () => void { return () => {}; }
  async start(): Promise<void> {}
}

/** True only when both credentials are present and not obvious placeholders. */
export function daouConfigured(user?: string, password?: string): boolean {
  return [user, password].every((v) => {
    if (v == null || !v.trim()) return false;
    const lower = v.toLowerCase();
    return !lower.includes("changeme") && !lower.includes("placeholder");
  });
}
