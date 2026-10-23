/**
 * 유비온봇 대화 요약 / 안 읽은 메시지 요약 (client side of feature 4). The client only posts a
 * command line to the 유비온봇 bot room (the 나 room / memo-to-self); the bot reads that room and
 * does the actual summarization on its own side. No company message content is ever sent to an LLM
 * from the client.
 *
 * ⚠ Needs a server deploy (the bot must understand /요약). Behind UBM_BOT_SUMMARY=1.
 * The command is a NEW message-sending path, so it must pass the shared self-only guard
 * (checkForwardTarget) — it is only ever sent to the 나 room.
 */
import { apiRoomSeq, checkForwardTarget } from "./forward";
import type { Room } from "./types";
import { composeSummaryCommand, normalizeRecentN, normalizeSummaryMode, type SummaryMode } from "../../src/lib/bot-summary";

export const BOT_SUMMARY_ENV = "UBM_BOT_SUMMARY";
export const BOT_SUMMARY_DISABLED_TEXT = "유비온봇 요약은 아직 지원되지 않습니다";
export const BOT_SUMMARY_NO_SELF_ROOM_TEXT = "나와의 대화방을 찾을 수 없습니다";

export type BotSummaryCaps = { enabled: boolean; selfOnly: boolean };

export function botSummaryEnabled(env: Record<string, string | undefined> | undefined): boolean {
  return env?.[BOT_SUMMARY_ENV] === "1";
}

export function botSummaryCaps(env: Record<string, string | undefined> | undefined): BotSummaryCaps {
  return { enabled: botSummaryEnabled(env), selfOnly: env?.UBM_SELF_ONLY === "1" };
}

/** Validate the renderer's room key (the room to summarize): `${kind}:${seq}`. */
export function normalizeSummaryRoomKey(value: unknown): string {
  if (typeof value !== "string") throw new Error("요약할 대화방이 없습니다");
  const key = value.trim();
  if (!/^(room|buddy|pubsub):\d+$/.test(key)) throw new Error("요약할 대화방이 올바르지 않습니다");
  return key;
}

/** Self-only guard for the summary command — it is always posted to the 나 room, never anywhere else. */
export function guardBotSummaryTarget({
  selfOnly,
  me,
  selfRoomSeq,
  selfRoom,
}: {
  selfOnly: boolean;
  me: number;
  selfRoomSeq?: number | null;
  selfRoom: Pick<Room, "kind" | "seq" | "buddyRoomSeq"> | null;
}): void {
  if (!selfRoom) throw new Error(BOT_SUMMARY_NO_SELF_ROOM_TEXT);
  checkForwardTarget({ selfOnly, target: { roomSeq: apiRoomSeq(selfRoom) }, me, selfRoomSeq });
}

export async function performBotSummary({
  guard,
  sendText,
  selfRoomKey,
  roomKey,
  mode,
  recentN,
}: {
  guard: () => void;
  sendText: (roomKey: string, text: string) => Promise<{ messageId?: number }>;
  selfRoomKey: string;
  roomKey: string;
  mode: SummaryMode;
  recentN?: number;
}): Promise<{ ok: true; messageId?: number }> {
  if (!selfRoomKey) throw new Error(BOT_SUMMARY_NO_SELF_ROOM_TEXT);
  guard();
  const res = await sendText(selfRoomKey, composeSummaryCommand(roomKey, mode, recentN));
  return { ok: true, messageId: res.messageId };
}

export { normalizeSummaryMode, normalizeRecentN };
