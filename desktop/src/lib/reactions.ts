import type { ReactionMap } from "../../electron/core/reactions";

export type ReactionChip = { emoji: string; count: number; mine: boolean };

/** Chips for one message: emoji + count, `mine` true when `me` is in the user list (own reaction highlighted). */
export function reactionChips(map: ReactionMap | undefined, messageId: number | undefined, me: number): ReactionChip[] {
  if (messageId == null || !map) return [];
  const byEmoji = map[String(messageId)];
  if (!byEmoji) return [];
  const chips: ReactionChip[] = [];
  for (const [emoji, seqs] of Object.entries(byEmoji)) {
    const list = Array.isArray(seqs) ? seqs : [];
    chips.push({ emoji, count: list.length, mine: list.includes(me) });
  }
  return chips;
}

/** Optimistically toggle `emoji` by `me` for the local map (the server response re-syncs on the next poll). */
export function applyToggle(map: ReactionMap, messageId: number, emoji: string, me: number): ReactionMap {
  const key = String(messageId);
  const next: ReactionMap = { ...map };
  const byEmoji: Record<string, number[]> = { ...(next[key] ?? {}) };
  const list = Array.isArray(byEmoji[emoji]) ? [...byEmoji[emoji]] : [];
  const idx = list.indexOf(me);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(me);
  if (list.length) byEmoji[emoji] = list;
  else delete byEmoji[emoji];
  if (Object.keys(byEmoji).length) next[key] = byEmoji;
  else delete next[key];
  return next;
}
