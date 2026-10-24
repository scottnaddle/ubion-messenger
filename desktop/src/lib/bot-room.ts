/** Names of the UBION bot account(s). Matched exactly after trimming. */
export const BOT_NAMES = ["유비온봇"] as const;

export type BotRoomLike = { kind?: string | null; name?: string | null; peerUserId?: number | null } | null | undefined;
export type BotMemberLike = { name?: string | null } | null | undefined;

function botName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The company bot's own 1:1 room: name is 유비온봇, or the peer is the known bot user. */
export function isCompanyBotRoom(room: BotRoomLike, botUserSeq?: number | null): boolean {
  if (!room || room.kind !== "buddy") return false;
  const name = botName(room.name);
  if (name && (BOT_NAMES as readonly string[]).includes(name)) return true;
  const bot = typeof botUserSeq === "number" ? botUserSeq : Number(botUserSeq);
  return Number.isFinite(bot) && bot > 0 && room.peerUserId === bot;
}

/**
 * Keep every company-bot room at the front, in their existing relative order.
 * Other rooms (including user pins) stay in the order they were given.
 */
export function pinCompanyBotRooms<T extends BotRoomLike>(rooms: readonly T[], botUserSeq?: number | null): T[] {
  const bots: T[] = [];
  const rest: T[] = [];
  for (const room of rooms) (isCompanyBotRoom(room, botUserSeq) ? bots : rest).push(room);
  if (!bots.length) return rooms as T[];
  const alreadyFirst = rooms.slice(0, bots.length).every((room, i) => room === bots[i]);
  return alreadyFirst ? rooms as T[] : [...bots, ...rest];
}

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
