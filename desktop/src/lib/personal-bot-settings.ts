/**
 * Layout for the 내 봇 settings window. Sections are an ordered list so a new
 * page is another id here, not a new dropdown. Only sections that exist today
 * are listed.
 */
import { normalizeConnectorPrefs, type ConnectorPrefs } from "./connectors";

export const BOT_SETTINGS_SECTIONS = ["connectors"] as const;
export type BotSettingsSectionId = (typeof BOT_SETTINGS_SECTIONS)[number];

export type BotSettingsLink = { connected: boolean; account?: string };
export type BotSettingsSnapshot = {
  prefs: ConnectorPrefs;
  links: Record<string, BotSettingsLink>;
};

export function selectBotSettingsSection(id: unknown): BotSettingsSectionId {
  const wanted = typeof id === "string" ? id : "";
  return (BOT_SETTINGS_SECTIONS as readonly string[]).includes(wanted)
    ? (wanted as BotSettingsSectionId)
    : BOT_SETTINGS_SECTIONS[0];
}

/** Nav model: exactly one section is active, and unknown ids fall back to the first. */
export function settingsNav(active: unknown): { id: BotSettingsSectionId; active: boolean }[] {
  const selected = selectBotSettingsSection(active);
  return BOT_SETTINGS_SECTIONS.map((id) => ({ id, active: id === selected }));
}

export function botSettingsQuery(userId: number): { botSettings: string; userId: string } {
  return { botSettings: "1", userId: String(userId) };
}

export function rendererUrlWithBotSettings(rendererUrl: string, userId: number): string {
  const url = new URL(rendererUrl);
  const query = botSettingsQuery(userId);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

/** `?botSettings=1&userId=` on the renderer. Missing or invalid user id does not open the window view. */
export function parseBotSettingsSearch(search: string): { userId: number } | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (params.get("botSettings") !== "1") return null;
  const userId = Number(params.get("userId"));
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  return { userId };
}

function readSettingsLinks(data: unknown): Record<string, BotSettingsLink> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const links: Record<string, BotSettingsLink> = {};
  for (const [id, value] of Object.entries(data)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const connected = (value as { connected?: unknown }).connected === true;
    const account = (value as { account?: unknown }).account;
    const trimmed = typeof account === "string" ? account.trim() : "";
    links[id] = trimmed ? { connected, account: trimmed } : { connected };
  }
  return links;
}

/** Parent chat applies this after the settings window changes a toggle or a Google link. */
export function readSettingsSnapshot(value: unknown): BotSettingsSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as { prefs?: unknown; links?: unknown };
  return {
    prefs: normalizeConnectorPrefs(raw.prefs),
    links: readSettingsLinks(raw.links),
  };
}
