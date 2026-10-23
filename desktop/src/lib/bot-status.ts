export type BotStatusState = "thinking" | "working" | "done";

/** Event emitted by the messenger core, keyed to the room the status belongs to. */
export type BotStatusUpdate = {
  roomKey: string;
  userId: number;
  state: BotStatusState;
  text: string;
};

export type BotStatusEntry = BotStatusUpdate & { at: number };
export type BotStatusMap = Record<string, BotStatusEntry>;

export type ParsedBotStatus = {
  local: string;
  state: BotStatusState;
  text: string;
  room?: string;
};

export const BOT_STATUS_TTL_MS = 60_000;

const STATES = new Set<BotStatusState>(["thinking", "working", "done"]);
const ROOM_RE = /^room:\d+$/;

function attrValue(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(['"])(.*?)\\1`).exec(tag);
  return m ? m[2] : undefined;
}

/** Parse a body-less `<message>` carrying `<bot-status xmlns="urn:ubion:bot-status">`. */
export function parseBotStatus(
  stanza: string,
  unescape: (s: string) => string = (s) => s,
): ParsedBotStatus | null {
  if (!/<message\b/.test(stanza)) return null;
  if (/<body(?:\s|\/|>)/.test(stanza)) return null;
  if (!stanza.includes("urn:ubion:bot-status")) return null;

  const message = /<message\b([^>]*)>/.exec(stanza);
  const from = message && attrValue(message[1], "from");
  if (!from) return null;
  const local = unescape(from).split("/")[0].split("@")[0];
  if (!local) return null;

  const open = /<bot-status\b([^>]*)>/.exec(stanza);
  if (!open) return null;
  const attrs = open[1];
  const stateRaw = attrValue(attrs, "state");
  const state = stateRaw == null ? "" : unescape(stateRaw).trim();
  if (!STATES.has(state as BotStatusState)) return null;

  let room: string | undefined;
  const roomRaw = attrValue(attrs, "room");
  if (roomRaw != null) {
    const candidate = unescape(roomRaw).trim();
    if (!ROOM_RE.test(candidate)) return null;
    room = candidate;
  }

  let text = "";
  if (!/\/\s*>$/.test(open[0])) {
    const close = stanza.indexOf("</bot-status>", open.index + open[0].length);
    if (close < 0) return null;
    // cap by code point so emoji are never split into lone surrogates
    text = Array.from(unescape(stanza.slice(open.index + open[0].length, close)).trim()).slice(0, 60).join("");
  }

  return { local, state: state as BotStatusState, text, room };
}

/** Apply a live status; a "done" state clears the room's entry (only if it's that author's). */
export function applyBotStatus(map: BotStatusMap, update: BotStatusUpdate, now: number): BotStatusMap {
  if (update.state === "done" && map[update.roomKey]?.userId !== update.userId) return map;
  const next = { ...map };
  if (update.state === "done") delete next[update.roomKey];
  else next[update.roomKey] = { ...update, at: now };
  return next;
}

/** A real message from the status author clears their status in that room. */
export function clearBotStatusForMessage(map: BotStatusMap, roomKey: string, userId: number): BotStatusMap {
  const current = map[roomKey];
  if (!current || current.userId !== userId) return map;
  const next = { ...map };
  delete next[roomKey];
  return next;
}

/** Drop entries older than the timeout (60s after the last status). */
export function expireBotStatuses(map: BotStatusMap, now: number, ttlMs = BOT_STATUS_TTL_MS): BotStatusMap {
  let changed = false;
  const next = { ...map };
  for (const [roomKey, entry] of Object.entries(next)) {
    if (now - entry.at >= ttlMs) {
      delete next[roomKey];
      changed = true;
    }
  }
  return changed ? next : map;
}

/** Korean default labels when the server sends no text. */
export function botStatusLabel(state: BotStatusState, text: string): string {
  if (text) return text;
  if (state === "working") return "작업 중";
  if (state === "thinking") return "생각 중";
  return "";
}
