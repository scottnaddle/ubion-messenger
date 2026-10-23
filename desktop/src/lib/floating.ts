export type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * Collision-aware placement for popups anchored to a button: prefer above the anchor, flip below when
 * there is no room, align to the anchor's start edge (or end edge for `align: "end"`), then shift so the
 * popup stays inside `bounds` (the chat pane ∩ viewport). Coordinates are viewport (position: fixed).
 */
export function placeFloating(
  anchor: Rect, size: { width: number; height: number }, bounds: Rect,
  opts: { gap?: number; align?: "start" | "end"; margin?: number } = {},
): { left: number; top: number; placement: "top" | "bottom" } {
  const gap = opts.gap ?? 4;
  const m = opts.margin ?? 6;
  const above = anchor.top - gap - size.height;
  const below = anchor.bottom + gap;
  let placement: "top" | "bottom" = "top";
  let top = above;
  if (above < bounds.top + m && below + size.height <= bounds.bottom - m) {
    placement = "bottom";
    top = below;
  }
  top = Math.max(bounds.top + m, Math.min(top, bounds.bottom - m - size.height));
  let left = opts.align === "end" ? anchor.right - size.width : anchor.left;
  left = Math.min(left, bounds.right - m - size.width);
  left = Math.max(left, bounds.left + m);
  return { left: Math.round(left), top: Math.round(top), placement };
}

export function intersectRect(a: Rect, b: Rect): Rect {
  const r = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return r.right - r.left < 80 || r.bottom - r.top < 80 ? b : r;
}
