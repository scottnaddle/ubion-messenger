export const NAV_ORDER = ["home", "chats", "mail", "flex", "people", "menu"] as const;

export type NavView = (typeof NAV_ORDER)[number];

/** ⌘/Ctrl+1..6 → rail view in NAV_ORDER; anything else → null. */
export function navForDigit(d: string | number): NavView | null {
  const n = typeof d === "number" ? d : Number(String(d).trim());
  if (!Number.isInteger(n) || n < 1 || n > NAV_ORDER.length) return null;
  return NAV_ORDER[n - 1];
}
