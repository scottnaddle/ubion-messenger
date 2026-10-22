/**
 * Korean keyword matching: exact, synonym, substring, choseong (초성), light fuzzy.
 * Pure — no Electron deps.
 */

/** Hangul syllable → choseong index 0..18 */
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

export function toChoseong(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0xac00 && c <= 0xd7a3) {
      out += CHO[Math.floor((c - 0xac00) / 588)] || "";
    } else if (CHO.includes(ch)) {
      out += ch;
    }
    // skip non-hangul for choseong string
  }
  return out;
}

export function normalizeQuery(q: string): string {
  return q.replace(/\s+/g, "").toLowerCase();
}

/** Levenshtein distance capped */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      rowMin = Math.min(rowMin, dp[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return dp[m][n];
}

export type MatchScore = { score: number; reason: string };

/**
 * Score how well `query` matches an item with `name` and optional `aliases`.
 * Higher is better; 0 = no match.
 */
export function scoreMatch(query: string, name: string, aliases: string[] = []): MatchScore {
  const q = normalizeQuery(query);
  if (!q) return { score: 0, reason: "empty" };
  const names = [name, ...aliases].map((n) => n.trim()).filter(Boolean);
  let best: MatchScore = { score: 0, reason: "none" };

  for (const n of names) {
    const nn = normalizeQuery(n);
    if (!nn) continue;
    if (nn === q) return { score: 100, reason: "exact" };
    if (nn.startsWith(q)) best = pick(best, { score: 90, reason: "prefix" });
    if (nn.includes(q)) best = pick(best, { score: 75, reason: "contains" });
    // choseong: query is all choseong chars
    if (/^[ㄱ-ㅎ]+$/.test(q)) {
      const ch = toChoseong(n);
      if (ch === q) best = pick(best, { score: 85, reason: "choseong-exact" });
      else if (ch.startsWith(q)) best = pick(best, { score: 70, reason: "choseong-prefix" });
      else if (ch.includes(q)) best = pick(best, { score: 55, reason: "choseong-contains" });
    } else {
      // query choseong vs name choseong prefix (e.g. ㅎㅇㅅ → 회의실)
      const qCh = toChoseong(query);
      const nCh = toChoseong(n);
      if (qCh.length >= 2 && nCh.startsWith(qCh)) best = pick(best, { score: 65, reason: "choseong-of-query" });
    }
    if (q.length >= 2 && nn.length <= 24) {
      const d = editDistance(q, nn, 2);
      if (d <= 2) best = pick(best, { score: 50 - d * 8, reason: "fuzzy" });
    }
  }
  return best;
}

function pick(a: MatchScore, b: MatchScore) {
  return b.score > a.score ? b : a;
}
