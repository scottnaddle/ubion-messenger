/**
 * Command palette: pure item model + fuzzy ranking, Korean 초성-aware.
 * The renderer builds items (rooms, people, screens/actions) and this module
 * filters + ranks them by a typed query. No DOM/Node APIs.
 */

export type PaletteKind = "room" | "person" | "screen" | "action";

export type PaletteItem = {
  id: string;
  kind: PaletteKind;
  /** Primary text matched against the query. */
  label: string;
  /** Secondary text (e.g. position / last-message preview). */
  sublabel?: string;
  /** Extra searchable text not shown (e.g. English synonyms). */
  keywords?: string;
  roomKey?: string;
  userId?: number;
  view?: string;
  icon?: string;
  unread?: number;
};

/** 초성 table: ㄱ…ㅎ indexed by the leading consonant of a Hangul syllable. */
const CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

/** Reduce Hangul text to its 초성; non-Hangul characters pass through unchanged. */
export function getChoseong(str: string): string {
  let out = "";
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) out += CHOSEONG[Math.floor((code - 0xac00) / 588)];
    else out += ch;
  }
  return out;
}

export const PALETTE_MAX = 8;

/** Rank of a single text against a query: lower is better; null = no match. */
function scoreText(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  const s = text.toLowerCase();
  if (!q) return 0;
  if (!s) return null;

  if (s === q) return 0; // exact
  if (s.startsWith(q)) return 1; // prefix
  if (s.includes(q)) return 2; // substring

  // 초성 search (a plus): "ㄱㅈ" matches "결재".
  const qChoseong = getChoseong(q);
  const sChoseong = getChoseong(text);
  if (sChoseong === qChoseong) return 3;
  if (sChoseong.startsWith(qChoseong)) return 4;
  if (sChoseong.includes(qChoseong)) return 5;
  return null;
}

/**
 * Filter + rank items by query. Lower score wins, ties keep the original order.
 * An empty query returns the first `limit` items in their given order.
 */
export function rankPalette(items: PaletteItem[], query: string, limit = PALETTE_MAX): PaletteItem[] {
  const scored: { item: PaletteItem; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    let best: number | null = null;
    for (const text of [item.label, item.sublabel || "", item.keywords || ""]) {
      const sc = scoreText(query, text);
      if (sc == null) continue;
      if (best == null || sc < best) best = sc;
    }
    if (best == null) return;
    scored.push({ item, score: best, index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.slice(0, limit).map((s) => s.item);
}
