export const NAV_ORDER = ["home", "chats", "mail", "flex", "people", "menu"] as const;

export type NavView = (typeof NAV_ORDER)[number];

/** Company flavor keeps flex in the rail. Generic drops it so the digit shortcuts stay contiguous. */
export function navOrder(includeFlex = true): readonly NavView[] {
  return includeFlex ? NAV_ORDER : NAV_ORDER.filter((id) => id !== "flex");
}

/** ⌘/Ctrl+1..n → rail view. Default order is the company rail. */
export function navForDigit(d: string | number, order: readonly NavView[] = NAV_ORDER): NavView | null {
  const n = typeof d === "number" ? d : Number(String(d).trim());
  if (!Number.isInteger(n) || n < 1 || n > order.length) return null;
  return order[n - 1];
}
