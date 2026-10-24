import { useEffect, useState } from "react";

/** iPhone-class widths: single-pane layout. iPad (incl. most split-view widths) stays two-pane.
 *  iPhone landscape is often wider than 767px; the iPad rail (wider, larger icons, top safe area)
 *  is gated in mobile.css on `(min-width: 768px) and (min-height: 600px)` so a short landscape
 *  phone keeps the 72px rail. */
export const COMPACT_QUERY = "(max-width: 767px)";

/** True only in the Capacitor build (main.tsx adds the class); desktop layout never changes. */
export function isMobileUi(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("ubm-mobile");
}

function matches(): boolean {
  return isMobileUi() && typeof window !== "undefined" && !!window.matchMedia?.(COMPACT_QUERY).matches;
}

/** Mobile build + viewport ≤767px. Always false on desktop, whatever the window size. */
export function useIsCompact(): boolean {
  const [compact, setCompact] = useState(matches);
  useEffect(() => {
    if (!isMobileUi() || !window.matchMedia) return;
    const mq = window.matchMedia(COMPACT_QUERY);
    const on = () => setCompact(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return compact;
}
