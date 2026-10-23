import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { intersectRect, placeFloating, type Rect } from "../lib/floating";

/** Body-level portal popup positioned next to `anchor`, kept inside the chat pane and the viewport. */
export function Floating({ anchor, children, align = "start", boundsSelector = ".msg-list" }: {
  anchor: React.RefObject<HTMLElement | null>; children: ReactNode; align?: "start" | "end"; boundsSelector?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const update = () => {
      const a = anchor.current;
      const el = ref.current;
      if (!a || !el) return;
      const vp: Rect = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      const pane = a.closest(boundsSelector)?.getBoundingClientRect();
      const bounds = pane ? intersectRect(pane, vp) : vp;
      const r = el.getBoundingClientRect();
      setPos(placeFloating(a.getBoundingClientRect(), { width: r.width, height: r.height }, bounds, { align }));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [anchor, align, boundsSelector]);
  return createPortal(
    <div ref={ref} className="floating-layer"
      style={{ position: "fixed", zIndex: 10000, left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? "visible" : "hidden" }}>
      {children}
    </div>,
    document.body,
  );
}
