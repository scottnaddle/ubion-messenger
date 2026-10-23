/** '@' mention helpers shared by the renderer and the Electron main process. Pure, no DOM/Node APIs. */

export type MentionTrigger = { start: number; query: string };

export type MentionMember = {
  userId: number;
  name: string;
  position?: string;
  department?: string;
};

export type MentionSegment = { type: "text" | "mention"; value: string; name?: string };

const isWhitespace = (ch: string) => /\s/.test(ch);

/** True for letters/digits (including Hangul) — used to avoid matching inside longer words. */
const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);

/** Start of text, whitespace or punctuation may precede a mention; letters/digits may not. */
const isBoundaryBefore = (ch: string | undefined) => !isWordChar(ch);

/**
 * Finds an active mention trigger at the cursor.
 * An '@' only counts at the start of the text or right after whitespace (so `a@b.com` never triggers).
 * The query is the text between '@' and the cursor and must not contain whitespace/newlines.
 */
export function findMentionTrigger(text: string, cursor: number): MentionTrigger | null {
  if (!text) return null;
  const end = Math.max(0, Math.min(cursor, text.length));
  if (end <= 0) return null;

  let tokenStart = end - 1;
  while (tokenStart >= 0 && !isWhitespace(text[tokenStart])) tokenStart--;
  tokenStart += 1;

  // caret right after whitespace: no token before it (don't look at the character after the caret)
  if (tokenStart >= end || text[tokenStart] !== "@") return null;
  const query = text.slice(tokenStart + 1, end);
  for (const ch of query) if (isWhitespace(ch)) return null;

  return { start: tokenStart, query };
}

/**
 * Filters mention candidates by name/position/department (case-insensitive), excluding me.
 * Ranking: name startsWith, then name includes, then other fields; stable; max 8.
 */
export function filterMembers<T extends MentionMember>(members: T[], query: string, meId: number): T[] {
  const q = (query || "").toLocaleLowerCase();
  const scored: { member: T; rank: number; index: number }[] = [];

  members.forEach((member, index) => {
    if (member.userId === meId) return;
    const name = (member.name || "").toLocaleLowerCase();
    const position = (member.position || "").toLocaleLowerCase();
    const department = (member.department || "").toLocaleLowerCase();

    let rank: number;
    if (!q) rank = 0;
    else if (name.startsWith(q)) rank = 0;
    else if (name.includes(q)) rank = 1;
    else if (position.includes(q) || department.includes(q)) rank = 2;
    else return;

    scored.push({ member, rank, index });
  });

  scored.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return scored.slice(0, 8).map((s) => s.member);
}

/** Replaces the active '@query' with '@name ' and returns the next caret position. */
export function insertMention(
  text: string,
  trigger: MentionTrigger,
  cursorEnd: number,
  name: string,
): { text: string; cursor: number } {
  const start = Math.max(0, Math.min(trigger.start, text.length));
  const end = Math.max(start, Math.min(cursorEnd, text.length));
  const inserted = `@${name} `;
  return {
    text: text.slice(0, start) + inserted + text.slice(end),
    cursor: start + inserted.length,
  };
}

/**
 * Splits text into text/mention segments for the supplied member names.
 * Names with spaces are matched fully (longest name first) at word/punctuation boundaries.
 */
export function parseMentionTokens(text: string, memberNames: string[]): MentionSegment[] {
  const names = [...new Set(memberNames.filter((n) => !!n))].sort((a, b) => b.length - a.length);
  if (!text || !names.length) return text ? [{ type: "text", value: text }] : [];

  const out: MentionSegment[] = [];
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer) {
      out.push({ type: "text", value: buffer });
      buffer = "";
    }
  };

  while (i < text.length) {
    if (text[i] === "@" && isBoundaryBefore(i === 0 ? undefined : text[i - 1])) {
      const name = names.find((n) => text.startsWith(n, i + 1));
      if (name && !isWordChar(text[i + 1 + name.length])) {
        flush();
        out.push({ type: "mention", value: `@${name}`, name });
        i += 1 + name.length;
        continue;
      }
    }
    buffer += text[i];
    i += 1;
  }

  flush();
  return out;
}

/** True when the text contains a mention of my full display name (spaces included). */
export function isMentioningMe(text: string, myName: string): boolean {
  const name = (myName || "").trim();
  if (!name) return false;
  return parseMentionTokens(text, [name]).some((s) => s.type === "mention");
}
