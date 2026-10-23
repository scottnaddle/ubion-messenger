import { NAV_ORDER, type NavView } from "./nav";

export type RailTipId = NavView | "approval" | "settings" | "profile";

export const RAIL_TOOLTIP_DELAY_MS = 300;

const TIPS: Record<RailTipId, { label: string; keys: readonly string[] }> = {
  home: { label: "홈", keys: ["1"] },
  chats: { label: "메시지", keys: ["2", "K"] },
  mail: { label: "메일", keys: ["3"] },
  flex: { label: "플렉스", keys: ["4"] },
  people: { label: "조직도", keys: ["5", "N"] },
  menu: { label: "앱", keys: ["6"] },
  approval: { label: "전자결재", keys: [] },
  settings: { label: "설정", keys: [","] },
  profile: { label: "프로필", keys: [] },
};

export function isMacPlatform(platform?: string | null): boolean {
  const p = platform ?? (typeof navigator !== "undefined" ? navigator.platform : "");
  return /mac|darwin/i.test(p);
}

export function railLabel(id: RailTipId, name?: string): string {
  return id === "profile" && name ? name : TIPS[id].label;
}

export function railShortcut(id: RailTipId, platform?: string | null): string {
  const mod = isMacPlatform(platform) ? "⌘" : "Ctrl+";
  return TIPS[id].keys.map((key) => mod + key).join("/");
}

export function railTipFor(
  id: RailTipId,
  opts: { platform?: string | null; name?: string } = {},
): { label: string; shortcut: string } {
  return {
    label: railLabel(id, opts.name),
    shortcut: railShortcut(id, opts.platform),
  };
}

export function navRailTips(
  opts: { platform?: string | null } = {},
): { id: NavView; label: string; shortcut: string }[] {
  return NAV_ORDER.map((id) => ({ id, ...railTipFor(id, opts) }));
}

export function nextShowDelay(
  lastHiddenAt: number | null | undefined,
  now: number,
  visible: boolean,
): number {
  if (visible) return 0;
  if (
    lastHiddenAt != null &&
    lastHiddenAt > 0 &&
    now >= lastHiddenAt &&
    now - lastHiddenAt <= RAIL_TOOLTIP_DELAY_MS
  ) {
    return 0;
  }
  return RAIL_TOOLTIP_DELAY_MS;
}
