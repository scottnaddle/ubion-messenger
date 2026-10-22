import type { WizardHit } from "./types";

/**
 * Empty-query order: manual pins (pin array order) → most-recently-used → usage frequency → title.
 * No auto-pin.
 */
export function sortBrowseHits(hits: WizardHit[], pinOrder: string[]): WizardHit[] {
  const pinIndex = new Map(pinOrder.map((id, i) => [id, i]));
  return [...hits].sort((a, b) => {
    const ap = pinIndex.has(a.id);
    const bp = pinIndex.has(b.id);
    if (ap && bp) return (pinIndex.get(a.id)! - pinIndex.get(b.id)!);
    if (ap !== bp) return ap ? -1 : 1;
    const al = a.lastUsedAt || 0;
    const bl = b.lastUsedAt || 0;
    if (al !== bl) return bl - al;
    if (a.usage !== b.usage) return b.usage - a.usage;
    return a.title.localeCompare(b.title, "ko");
  });
}

/**
 * Search order: match relevance (score) primary → recency → frequency → title.
 * Pins do not override relevance; among equal scores, pinned first in pin order, then recency.
 */
export function sortSearchHits(hits: WizardHit[], pinOrder: string[]): WizardHit[] {
  const pinIndex = new Map(pinOrder.map((id, i) => [id, i]));
  return [...hits].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ap = pinIndex.has(a.id);
    const bp = pinIndex.has(b.id);
    if (ap && bp) return pinIndex.get(a.id)! - pinIndex.get(b.id)!;
    if (ap !== bp) return ap ? -1 : 1;
    const al = a.lastUsedAt || 0;
    const bl = b.lastUsedAt || 0;
    if (al !== bl) return bl - al;
    if (a.usage !== b.usage) return b.usage - a.usage;
    return a.title.localeCompare(b.title, "ko");
  });
}
