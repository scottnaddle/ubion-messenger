import { useEffect, useRef, useState } from "react";
import { REACTION_EMOJI, type ReactionMap } from "../../electron/core/reactions";
import { formatReactionTooltip, reactionChips } from "../lib/reactions";
import { loadRecentEmoji, pushRecentEmoji, saveRecentEmoji } from "../lib/emoticon";
import { useT } from "../lib/i18n";
import { EmojiPicker } from "./EmojiPicker";
import { Floating } from "./Floating";

/**
 * 이모지 리액션: chips beside the bubble (own reaction highlighted) + a hover "+" button.
 * The compact palette has the 8 quick emoji; "더보기" opens the full composer picker.
 */
export type ReactionPickerState = { messageId: number; mode: "palette" | "full" } | null;

/** Chips + the "+" button. Presentational: the open palette lives in ChatView (see ReactionPopup). */
export function ReactionBar({
  map, messageId, me, names, onToggle, open = false, onOpenPicker, disabledReason = null,
}: {
  map: ReactionMap | undefined;
  messageId: number | undefined;
  me: number;
  names?: ReadonlyMap<number, string>;
  onToggle: (emoji: string) => void;
  open?: boolean;
  onOpenPicker?: (mode: "palette" | "full" | null) => void;
  disabledReason?: string | null;
}) {
  const t = useT();
  const chips = reactionChips(map, messageId, me);
  if (messageId == null) return null;
  const byEmoji = map?.[String(messageId)] ?? {};
  const nameFor = (seq: number): string | undefined => (seq === me ? t("나") : names?.get(seq));
  return (
    <div className="reactions">
      {chips.length > 0 && (
        <span className="reaction-chips">
          {chips.map((c) => {
            const label = formatReactionTooltip(c.emoji, byEmoji[c.emoji] ?? [], nameFor);
            return (
              <button key={c.emoji} type="button" title={label} aria-label={label} disabled={!!disabledReason}
                className={`reaction-chip${c.mine ? " mine" : ""}`} onClick={() => onToggle(c.emoji)}>
                <span className="reaction-emoji">{c.emoji}</span>
                <span className="reaction-count">{c.count}</span>
              </button>
            );
          })}
        </span>
      )}
      <button type="button" className={`reaction-add${disabledReason ? " disabled" : ""}`} data-reaction-add={messageId}
        aria-label={t("리액션")} title={disabledReason ? t(disabledReason) : t("리액션")}
        aria-disabled={!!disabledReason} aria-expanded={open}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => { if (!disabledReason) onOpenPicker?.(open ? null : "palette"); }}>
        <span aria-hidden="true">☺+</span>
      </button>
    </div>
  );
}

/**
 * The single reaction palette / full picker for the chat, owned by ChatView so message-list re-renders,
 * reaction polls and row remounts never close it. Closes only on an outside click, Esc, or a pick.
 */
export function ReactionPopup({ state, onPick, onMode, onClose }: {
  state: NonNullable<ReactionPickerState>;
  onPick: (emoji: string) => void;
  onMode: (mode: "palette" | "full") => void;
  onClose: () => void;
}) {
  const t = useT();
  const [recent, setRecent] = useState<string[]>(() => loadRecentEmoji());
  const popRef = useRef<HTMLSpanElement>(null);
  const anchorEl = () => document.querySelector<HTMLElement>(`[data-reaction-add="${state.messageId}"]`);
  const anchor = useRef<HTMLElement | null>(null);
  anchor.current = anchorEl();
  const pick = (emoji: string) => {
    setRecent((list) => {
      const next = pushRecentEmoji(list, emoji);
      saveRecentEmoji(next);
      return next;
    });
    onPick(emoji);
  };
  useEffect(() => {
    if (state.mode !== "palette") return;
    const down = (e: MouseEvent) => {
      if (isInsideReactionUi(e.target as Node | null, popRef.current, anchorEl())) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", down); window.removeEventListener("keydown", key); };
  }, [state.mode, state.messageId, onClose]);
  return (
    <Floating getAnchor={anchorEl}>
      {state.mode === "palette" ? (
        <span ref={popRef} className="reaction-pop floating" role="menu" aria-label={t("리액션")}>
          {REACTION_EMOJI.map((e) => (
            <button key={e} type="button" className="reaction-cell" title={e} aria-label={e} onClick={() => pick(e)}>{e}</button>
          ))}
          <button type="button" className="reaction-more" onClick={() => onMode("full")}>{t("더보기")}</button>
        </span>
      ) : (
        <EmojiPicker recent={recent} onPick={pick} onClose={onClose} anchor={anchor} floating />
      )}
    </Floating>
  );
}

export function isInsideReactionUi(node: Node | null, ...roots: (Node | null | undefined)[]): boolean {
  return !!node && roots.some((r) => !!r && r.contains(node));
}
