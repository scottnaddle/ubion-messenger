/** Names of the UBION bot account(s). Matched exactly after trimming. */
export const BOT_NAMES = ["유비온봇"] as const;

export type BotRoomLike = { kind?: string | null } | null | undefined;
export type BotMemberLike = { name?: string | null } | null | undefined;

/**
 * 자율활동 is only available in group chat rooms that include 유비온봇.
 * Buddy/pubsub rooms and rooms without the bot stay hidden.
 */
export function isBotGroupRoom(
  room: BotRoomLike,
  members: readonly BotMemberLike[] | null | undefined,
): boolean {
  if (!room || room.kind !== "room") return false;
  if (!Array.isArray(members)) return false;
  const names = new Set<string>(BOT_NAMES);
  return members.some((m) => {
    const name = typeof m?.name === "string" ? m.name.trim() : "";
    return !!name && names.has(name);
  });
}
