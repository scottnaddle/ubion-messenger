import type { ReactionMap } from "../../electron/core/reactions";

export type ReactionChip = { emoji: string; count: number; mine: boolean };

/** Normal poll interval while a room is visible. */
export const REACTION_POLL_MS = 5000;
/** First retry delay after a failed list call (network / 401 / 403 / 404 / 429). */
export const REACTION_BACKOFF_MS = 30_000;
/** Retry delay ceiling while the server stays unreachable. */
export const REACTION_BACKOFF_MAX_MS = 5 * 60_000;

/**
 * Chips for one message: emoji + count, `mine` true when `me` is in the user list (own reaction highlighted).
 * Busiest first; equal counts keep the server's first-seen reaction order so the row stays stable.
 */
export function reactionChips(map: ReactionMap | undefined, messageId: number | undefined, me: number): ReactionChip[] {
  if (messageId == null || !map) return [];
  const byEmoji = map[String(messageId)];
  if (!byEmoji) return [];
  return Object.entries(byEmoji)
    .map(([emoji, seqs], index) => {
      const list = Array.isArray(seqs) ? seqs : [];
      return { emoji, count: list.length, mine: list.includes(me), index };
    })
    .filter((chip) => chip.count > 0)
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map(({ emoji, count, mine }) => ({ emoji, count, mine }));
}

/** Optimistically toggle `emoji` by `me` for the local map (call again with the same args to revert). */
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

/**
 * Reconcile a toggle response (keyed by messageId) into the current map. Entries present in `update`
 * replace that message only; an empty emoji map removes the message's reactions entirely.
 */
export function mergeReactionUpdate(map: ReactionMap, update: ReactionMap): ReactionMap {
  const next: ReactionMap = { ...map };
  for (const [messageId, byEmoji] of Object.entries(update)) {
    if (Object.keys(byEmoji).length) next[messageId] = byEmoji;
    else delete next[messageId];
  }
  return next;
}

/**
 * Hover/aria label for a chip: emoji + first names, then the remaining count.
 * Unknown user seqs are not named; when none resolve, only the total count is shown.
 */
export function formatReactionTooltip(
  emoji: string,
  seqs: readonly number[],
  nameFor: (seq: number) => string | undefined,
  maxNames = 2,
): string {
  const names: string[] = [];
  for (const seq of seqs) {
    const name = nameFor(seq);
    if (name) names.push(name);
  }
  if (!names.length) return `${emoji} ${seqs.length}`;
  const shown = names.slice(0, Math.max(0, maxNames));
  const rest = seqs.length - shown.length;
  return `${emoji} ${shown.join(", ")}${rest > 0 ? ` 외 ${rest}명` : ""}`;
}

/** Newest `cap` message ids that can carry reactions, in chronological order. */
export function reactionPollIds(
  messages: readonly { messageId?: number | null }[],
  cap = 100,
): number[] {
  const limit = Math.max(0, Math.floor(cap));
  if (!limit) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const id = messages[i]?.messageId;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.reverse();
}

/** Next delay: 5 s while healthy, then 30 s → 60 s → … capped at 5 min after failures. */
export function nextReactionPollDelay(failures: number): number {
  if (!Number.isFinite(failures) || failures <= 0) return REACTION_POLL_MS;
  const exp = Math.min(Math.floor(failures) - 1, 10);
  return Math.min(REACTION_BACKOFF_MAX_MS, REACTION_BACKOFF_MS * 2 ** exp);
}

/**
 * Reaction UI visibility for a room. Caps off hides it; a failed list call hides it but keeps a quiet
 * retry running so it can reappear once the server is reachable again.
 */
export function reactionUiVisibility(capsEnabled: boolean, listFailed: boolean): { show: boolean; retry: boolean } {
  if (!capsEnabled) return { show: false, retry: false };
  if (listFailed) return { show: false, retry: true };
  return { show: true, retry: false };
}

/** Why the reaction entry in the message menu is disabled (null = usable). */
export function reactionDisabledReason(capsEnabled: boolean, listFailed: boolean, roomSupported: boolean): string | null {
  if (!capsEnabled) return "리액션 기능 꺼짐";
  if (!roomSupported) return "이 대화방은 리액션 미지원";
  if (listFailed) return "봇 서버 연결 안 됨";
  return null;
}
