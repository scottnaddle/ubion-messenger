import type { Poll } from "../../electron/core/polls";

/** Total vote count per option index (0 when no votes). */
export function pollTotals(poll: Poll): number[] {
  return poll.options.map((_, i) => (Array.isArray(poll.votes[i]) ? poll.votes[i].length : 0));
}

/** Option indices the caller (`me`) has voted for. */
export function pollMyVotes(poll: Poll, me: number): number[] {
  const out: number[] = [];
  for (const [idx, seqs] of Object.entries(poll.votes)) {
    if (Array.isArray(seqs) && seqs.includes(me)) out.push(Number(idx));
  }
  return out;
}

/**
 * Optimistically apply `me` voting on `optionIndex` (the server response re-syncs on the next fetch):
 * multi-select toggles, single-select replaces my previous vote. Never mutates the input.
 */
export function applyPollVote(poll: Poll, optionIndex: number, me: number): Poll {
  const votes: Record<number, number[]> = {};
  for (const [idx, seqs] of Object.entries(poll.votes)) {
    const n = Number(idx);
    const list = Array.isArray(seqs) ? [...seqs] : [];
    if (poll.multiSelect) {
      if (n === optionIndex) {
        const i = list.indexOf(me);
        if (i >= 0) list.splice(i, 1);
        else list.push(me);
      }
      if (list.length) votes[n] = list;
    } else if (n !== optionIndex) {
      const filtered = list.filter((s) => s !== me);
      if (filtered.length) votes[n] = filtered;
    }
  }
  if (!poll.multiSelect) {
    const list = Array.isArray(poll.votes[optionIndex]) ? [...poll.votes[optionIndex]] : [];
    if (!list.includes(me)) list.push(me);
    if (list.length) votes[optionIndex] = list;
  }
  return { ...poll, votes };
}
