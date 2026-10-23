import type React from "react";
import { useEffect, useRef, useState } from "react";
import { pickerCategories } from "../lib/emoticon";
import { useT } from "../lib/i18n";

/** Composer emoji popover. Closes on outside mousedown, Esc, or window blur. */
export function EmojiPicker({
  recent, onPick, onClose, anchor, floating = false,
}: {
  recent: string[]; onPick: (emoji: string) => void; onClose: () => void;
  /** The toggle button: clicks on it are left to its own handler (so it can close the picker). */
  anchor: React.RefObject<HTMLElement | null>;
  /** Rendered inside a positioned portal (reactions): drop the composer's absolute placement. */
  floating?: boolean;
}) {
  const t = useT();
  const cats = pickerCategories(recent);
  const [tab, setTab] = useState(cats[0].id);
  const ref = useRef<HTMLDivElement>(null);
  const current = cats.find((c) => c.id === tab) ?? cats[0];

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const node = e.target as Node;
      if (ref.current?.contains(node) || anchor.current?.contains(node)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key, true);
    if (!floating) window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose, anchor, floating]);

  return (
    <div className={`emoji-pop${floating ? " floating" : ""}`} ref={ref} role="dialog" aria-label={t("이모티콘")}>
      <div className="emoji-tabs" role="tablist">
        {cats.map((c) => (
          <button key={c.id} type="button" role="tab" aria-selected={c.id === current.id}
            className={`emoji-tab${c.id === current.id ? " on" : ""}`}
            onMouseDown={(e) => e.preventDefault()} onClick={() => setTab(c.id)}>
            {t(c.label)}
          </button>
        ))}
      </div>
      <div className="emoji-grid">
        {current.emoji.map((e) => (
          <button key={e} type="button" className="emoji-cell" title={e}
            onMouseDown={(ev) => ev.preventDefault()} onClick={() => onPick(e)}>
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
