import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { intersectRect, placeFloating, type Rect } from "../lib/floating";

/** Body-level portal popup positioned next to `anchor`, kept inside the chat pane and the viewport. */
export function Floating({ getAnchor, children, align = "start", boundsSelector = ".msg-list" }: {
  getAnchor: () => HTMLElement | null; children: ReactNode; align?: "start" | "end"; boundsSelector?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const getRef = useRef(getAnchor);
  getRef.current = getAnchor;
  useLayoutEffect(() => {
    const update = () => {
      const a = getRef.current();
      const el = ref.current;
      if (!a || !el || !a.isConnected) return; // row re-rendering: keep the last position
      const vp: Rect = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      const pane = a.closest(boundsSelector)?.getBoundingClientRect();
      const bounds = pane ? intersectRect(pane, vp) : vp;
      const r = el.getBoundingClientRect();
      const next = placeFloating(a.getBoundingClientRect(), { width: r.width, height: r.height }, bounds, { align });
      setPos((p) => (p && p.left === next.left && p.top === next.top ? p : { left: next.left, top: next.top }));
    };
    update();
    // Re-anchor after list re-renders (polls, new messages) without remounting the popup.
    const iv = window.setInterval(update, 250);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.clearInterval(iv); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [align, boundsSelector]);
  return createPortal(
    <div ref={ref} className="floating-layer"
      style={{ position: "fixed", zIndex: 10000, left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? "visible" : "hidden" }}>
      {children}
    </div>,
    document.body,
  );
}
