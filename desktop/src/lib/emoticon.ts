/**
 * 이모티콘: composer picker over a built-in Unicode emoji set.
 *
 * Emoji are inserted as plain text, so the wire format is just a normal chat message and
 * renders everywhere (original desktop app, mobile, web) without any client-side assets.
 *
 * DaouOffice stickers (original client: `resources/images/emoticon/`, actions
 * INIT_EMOTICONS / SELECTED_EMOTICON / MATCHED_EMOTICONS, `plainEmoticons` text codes) are
 * behind DAOU_STICKERS_ENABLED and off.
 * TODO(emoticon): before enabling we need (1) the original image assets copied from an installed
 * 3.5.42 `resources/images/emoticon/` (and packaged via electron-builder extraResources + a
 * renderer-reachable URL), and (2) one captured emoticon message sent to the 나 room to confirm
 * the wire format (plain "(name)" text code vs attach/extra field). Until both exist, the code
 * format below is a guess and must not be used for sending.
 */

import { tk } from "./i18n-core";

export type EmojiCategory = { id: string; label: string; emoji: string[] };

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    id: "face",
    label: tk("표정"),
    emoji: [
      "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "😉", "😊", "😇",
      "🥰", "😍", "😘", "😋", "😜", "🤪", "🤗", "🤭", "🤔", "🤨", "😐", "😑",
      "😶", "😏", "😒", "🙄", "😬", "😌", "😔", "😪", "😴", "😷", "🤒", "🥵",
      "🥶", "😵", "🤯", "😎", "🤓", "😕", "😟", "😮", "😲", "😳", "🥺", "😢",
      "😭", "😱", "😖", "😣", "😩", "😫", "😤", "😡", "🤬", "😈",
    ],
  },
  {
    id: "hand",
    label: tk("손"),
    emoji: [
      "👍", "👎", "👌", "✌️", "🤞", "🤟", "🤙", "👈", "👉", "👆", "👇", "☝️",
      "✋", "👋", "👏", "🙌", "👐", "🤝", "🙏", "💪", "✍️", "🫡",
    ],
  },
  {
    id: "heart",
    label: tk("하트"),
    emoji: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔", "❣️", "💕", "💖", "💗", "💯"],
  },
  {
    id: "object",
    label: tk("사물"),
    emoji: [
      "🎉", "🎊", "🎁", "🎂", "🔥", "✨", "⭐", "🌟", "☕", "🍺", "🍕", "🍚",
      "💡", "📌", "📎", "📅", "📝", "📢", "💻", "📱", "⏰", "✅", "❌", "⚠️",
    ],
  },
];

export const RECENT_EMOJI_KEY = "ubm.emoji.recent";
export const RECENT_EMOJI_MAX = 24;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Move `emoji` to the front, dedupe, cap at `max`. */
export function pushRecentEmoji(list: readonly string[], emoji: string, max = RECENT_EMOJI_MAX): string[] {
  if (!emoji) return list.slice(0, max);
  return [emoji, ...list.filter((e) => e !== emoji)].slice(0, max);
}

/** Parse the stored recent list; anything malformed yields []. */
export function parseRecentEmoji(raw: string | null | undefined, max = RECENT_EMOJI_MAX): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const e of v) {
      if (typeof e === "string" && e && e.length <= 16 && !out.includes(e)) out.push(e);
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function loadRecentEmoji(storage: StorageLike | undefined = globalThis.localStorage): string[] {
  try {
    return parseRecentEmoji(storage?.getItem(RECENT_EMOJI_KEY));
  } catch {
    return [];
  }
}

export function saveRecentEmoji(list: readonly string[], storage: StorageLike | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(RECENT_EMOJI_KEY, JSON.stringify(list.slice(0, RECENT_EMOJI_MAX)));
  } catch {
    // storage full / unavailable: recents are best-effort
  }
}

/** Picker tabs: 자주 사용 first (only when there are recents), then the built-in categories. */
export function pickerCategories(recent: readonly string[]): EmojiCategory[] {
  return recent.length ? [{ id: "recent", label: tk("자주 사용"), emoji: [...recent] }, ...EMOJI_CATEGORIES] : EMOJI_CATEGORIES;
}

/** Replace the [start, end) selection with `insert`; returns the new text and caret position. */
export function insertAtSelection(text: string, start: number, end: number, insert: string): { text: string; cursor: number } {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  return { text: text.slice(0, s) + insert + text.slice(e), cursor: s + insert.length };
}

// ---- DaouOffice sticker mode (flagged off; see TODO at top) ----

export const DAOU_STICKERS_ENABLED = false;

/** Sticker names known to exist under resources/images/emoticon/. Empty until assets are copied in. */
export const DAOU_STICKER_NAMES: ReadonlySet<string> = new Set<string>();

const STICKER_CODE_RE = /\(([A-Za-z0-9_-]{1,40})\)/g;

export type EmoticonSegment = { type: "text"; value: string } | { type: "sticker"; name: string; src: string; value: string };

/** Asset path for a sticker name. Names are restricted to [A-Za-z0-9_-] so no path traversal. */
export function emoticonImagePath(name: string): string {
  return `resources/images/emoticon/${name}.png`;
}

/**
 * Split text on "(name)" codes. Only names in `known` become stickers; everything else stays text.
 * With `enabled` false (default flag) the whole text is a single text segment.
 */
export function parseEmoticonCodes(
  text: string,
  known: ReadonlySet<string> = DAOU_STICKER_NAMES,
  enabled = DAOU_STICKERS_ENABLED,
): EmoticonSegment[] {
  if (!text) return [];
  if (!enabled || !known.size) return [{ type: "text", value: text }];
  const out: EmoticonSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(STICKER_CODE_RE)) {
    const name = m[1];
    if (!known.has(name)) continue;
    const at = m.index ?? 0;
    if (at > last) out.push({ type: "text", value: text.slice(last, at) });
    out.push({ type: "sticker", name, src: emoticonImagePath(name), value: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}
