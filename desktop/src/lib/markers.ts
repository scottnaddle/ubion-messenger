/**
 * Hidden message markers (M pattern) for features the DaouOffice server has no native API for:
 * message edit and quote reply. Both degrade readably in the original app:
 *
 *   edit:  "<body>\n(수정됨)[[ubm:edit:<origId>]]"
 *   reply: "> 이름: 원문…\n<reply>[[re:<msgId>]]"
 *
 * UBION strips the markers and renders a "(수정됨)" tag / a quote block with a jump target instead.
 * All functions are pure and used by both the renderer and the main process.
 */

const EDIT_MARKER = /\[\[ubm:edit:(\d+)\]\]/;
const REPLY_MARKER = /\[\[re:(\d+)\]\]/;
const EDIT_MARKERS = /\[\[ubm:edit:\d+\]\]/g;
const REPLY_MARKERS = /\[\[re:\d+\]\]/g;

export const EDIT_TAG = "(수정됨)";
export const QUOTE_TRUNCATE = 80;

export function encodeEditMarker(id: number): string {
  return `[[ubm:edit:${id}]]`;
}

export function encodeReplyMarker(id: number): string {
  return `[[re:${id}]]`;
}

function decodeId(re: RegExp, text: unknown): number | null {
  if (typeof text !== "string") return null;
  const m = text.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function decodeEditId(text: unknown): number | null {
  return decodeId(EDIT_MARKER, text);
}

export function decodeReplyId(text: unknown): number | null {
  return decodeId(REPLY_MARKER, text);
}

export function stripEditMarkers(text: unknown): string {
  return typeof text === "string" ? text.replace(EDIT_MARKERS, "") : "";
}

export function stripReplyMarkers(text: unknown): string {
  return typeof text === "string" ? text.replace(REPLY_MARKERS, "") : "";
}

/** Compose the edited message body: "<newText>\n(수정됨)[[ubm:edit:<origId>]]". */
export function composeEditText(newText: string, origId: number): string {
  return `${newText}\n${EDIT_TAG}${encodeEditMarker(origId)}`;
}

/** Remove the trailing "\n(수정됨)" tag after the edit markers have been stripped. */
export function stripEditTag(text: string): string {
  return text.replace(/\n\(수정됨\)\s*$/, "");
}

/** Collapse whitespace and truncate to a single readable line (for the quote block). */
export function truncateQuote(original: string, max = QUOTE_TRUNCATE): string {
  const oneLine = original.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, Math.max(0, max - 1)) + "…";
}

/** Compose the quote-reply message: "> 이름: 원문…\n<reply>[[re:<replyToId>]]". */
export function composeQuoteText(senderName: string, original: string, reply: string, replyToId: number): string {
  return `> ${senderName}: ${truncateQuote(original)}\n${reply}${encodeReplyMarker(replyToId)}`;
}

export type ParsedMessage = {
  /** Body with all markers and the quote block removed. */
  body: string;
  editedId: number | null;
  replyId: number | null;
  quote?: { senderName: string; text: string };
};

/** Split a received message into its quote block / body / hidden markers (for rendering). */
export function parseMessage(raw: string): ParsedMessage {
  const replyId = decodeReplyId(raw);
  let text = stripReplyMarkers(raw);
  const editedId = decodeEditId(text);
  text = editedId != null ? stripEditTag(stripEditMarkers(text)) : stripEditMarkers(text);

  let quote: ParsedMessage["quote"];
  if (replyId != null) {
    const lines = text.split("\n");
    const quoteLines: string[] = [];
    while (lines.length && /^> /.test(lines[0])) quoteLines.push(lines.shift()!);
    if (quoteLines.length) {
      const q = quoteLines.map((l) => l.slice(2)).join("\n");
      const sep = q.indexOf(": ");
      quote = sep >= 0 ? { senderName: q.slice(0, sep), text: q.slice(sep + 2) } : { senderName: "", text: q };
    }
    text = lines.join("\n");
  }

  return { body: text, editedId, replyId, quote };
}
