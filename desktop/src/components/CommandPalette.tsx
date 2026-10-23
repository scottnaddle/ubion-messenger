import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { rankPalette, type PaletteItem } from "../lib/palette";
import { Icon } from "./ui";
import { useT } from "../lib/i18n";

const KIND_ICON: Record<string, string> = { room: "chat", person: "people", screen: "grid", action: "more" };
const PALETTE_LIMIT = 8;
const RECENT_LIMIT = 20;

/** ⌘/Ctrl+K command palette: fuzzy jump to rooms, people, and screens. */
export function CommandPalette({
  items, onPick, onClose,
}: {
  items: PaletteItem[];
  onPick: (item: PaletteItem) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => rankPalette(items, q, q.trim() ? PALETTE_LIMIT : RECENT_LIMIT), [items, q]);

  useEffect(() => setSel(0), [q]);

  useEffect(() => {
    listRef.current?.querySelector(".selected")?.scrollIntoView?.({ block: "nearest" });
  }, [sel]);

  const activate = (item: PaletteItem) => {
    onPick(item);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(results.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[sel];
      if (item) activate(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return createPortal(
    <div className="modal-back palette-back" onClick={onClose}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label={t("명령 팔레트")} onClick={(e) => e.stopPropagation()}>
        <div className="search-box palette-input">
          <Icon name="search" size={16} />
          <input
            autoFocus
            placeholder={t("대화방, 사람, 메뉴 검색")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="palette-list" ref={listRef}>
          {results.map((item, i) => (
            <button
              key={item.id}
              className={`palette-item ${i === sel ? "selected" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => activate(item)}
            >
              <span className={`palette-kind ${item.kind}`}><Icon name={item.icon || KIND_ICON[item.kind]} size={16} /></span>
              <span className="palette-label">{item.label}</span>
              {item.sublabel ? <span className="palette-sub muted">{item.sublabel}</span> : null}
            </button>
          ))}
          {!results.length && <div className="muted small pad">{t("결과 없음")}</div>}
        </div>
        <div className="palette-foot muted tiny">{t("↑↓ 이동 · Enter 선택 · Esc 닫기")}</div>
      </div>
    </div>,
    document.body,
  );
}
