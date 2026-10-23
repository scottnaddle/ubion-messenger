/**
 * 상태 메시지 (free-text presence <status>) — pure helpers, no Electron.
 *
 * Sending keeps the existing away:on/online:on codes intact so the server's presence semantics
 * still work: a free-text status is appended as `<status>away:on|text</status>`. This is UNVERIFIED
 * against the relay (behind UBM_STATUS_XMPP=1) — the original app may not display it.
 *
 * Receiving: any `<status>` that is not a known presence code (away:on / online:on / away* / busy /
 * dnd / online*) is treated as a status message to display.
 */

export const STATUS_XMPP_ENV = "UBM_STATUS_XMPP";
export const STATUS_SERVER_ENV = "UBM_STATUS_SERVER";
export const STATUS_MAX_LENGTH = 100;

export const KNOWN_PRESENCE_CODES: ReadonlySet<string> = new Set(["away:on", "online:on"]);

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Presence stanza for the two states this client uses, optionally carrying a free-text status message.
 * Away also carries <show>away</show>; the code prefix (away:on / online:on) is preserved.
 */
export function presenceStanza(status: "online:on" | "away:on", text?: string): string {
  const t = text?.trim();
  if (!t) {
    return status === "away:on"
      ? "<presence><show>away</show><status>away:on</status></presence>"
      : "<presence><status>online:on</status></presence>";
  }
  const body = `${status}|${xmlEscape(t)}`;
  return status === "away:on"
    ? `<presence><show>away</show><status>${body}</status></presence>`
    : `<presence><status>${body}</status></presence>`;
}

/**
 * Extract a displayable status message from a received presence <status>, or null when the status
 * is only a presence code. `status` is expected to be already XML-unescaped.
 */
export function parseStatusMessage(status?: string, show?: string): string | null {
  const s = (status ?? "").trim();
  if (!s) return null;
  const pipe = s.indexOf("|");
  if (pipe >= 0) {
    const code = s.slice(0, pipe);
    if (KNOWN_PRESENCE_CODES.has(code)) {
      const text = s.slice(pipe + 1).trim();
      return text || null;
    }
  }
  if (KNOWN_PRESENCE_CODES.has(s)) return null;
  if (show) return s; // show=away/dnd etc. implies the status is a message, not a code
  const lower = s.toLowerCase();
  if (lower.startsWith("away") || lower.startsWith("busy") || lower.startsWith("dnd") || lower.startsWith("online")) return null;
  return s;
}

type Env = Record<string, string | undefined> | undefined;

export function statusXmppEnabled(env: Env): boolean {
  return env?.[STATUS_XMPP_ENV] === "1";
}

export function statusServerEnabled(env: Env): boolean {
  return env?.[STATUS_SERVER_ENV] === "1";
}

export type StatusCaps = { xmpp: boolean; server: boolean };

export function statusCaps(env: Env): StatusCaps {
  return { xmpp: statusXmppEnabled(env), server: statusServerEnabled(env) };
}

/** Trim/cap a status message before it goes on the wire. */
export function normalizeStatusText(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : "";
  return Array.from(s).slice(0, STATUS_MAX_LENGTH).join("");
}
