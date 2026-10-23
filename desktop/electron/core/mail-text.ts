/** Minimal HTML → text (no DOM): line breaks for block tags, strip tags, decode common entities. */
export function sanitizeHtmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/blockquote|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n").trim();
}
