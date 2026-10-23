/**
 * Redact secret-looking values before anything reaches a log.
 * Handles HTTP headers (`X-Daou-Session: ...`, `Cookie: ...`), query/form pairs
 * and JSON-ish `"pin": "1234"` / `password=...` objects.
 */
const SECRET_KEY = /(["']?)(x-daou-session|cookie|pin|password|token)\1(\s*[:=]\s*)(?:(['"])([\s\S]*?)\4|([^\r\n,&}]+))/gi;

export function maskSecrets(value: string): string {
  if (typeof value !== "string") return "";
  return value.replace(
    SECRET_KEY,
    (_match, keyQuote: string, key: string, sep: string, quote: string | undefined) => {
      const redacted = quote ? `${quote}***${quote}` : "***";
      return `${keyQuote}${key}${keyQuote}${sep}${redacted}`;
    },
  );
}
