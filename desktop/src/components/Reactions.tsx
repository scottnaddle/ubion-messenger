import { useRef, useState } from "react";
import { REACTION_EMOJI, type ReactionMap } from "../../electron/core/reactions";
import { formatReactionTooltip, reactionChips } from "../lib/reactions";
import { loadRecentEmoji, pushRecentEmoji, saveRecentEmoji } from "../lib/emoticon";
import { useT } from "../lib/i18n";
import { EmojiPicker } from "./EmojiPicker";

/**
 * 이모지 리액션: chips beside the bubble (own reaction highlighted) + a hover "+" button.
 * The compact palette has the 8 quick emoji; "더보기" opens the full composer picker.
 */
export function ReactionBar({
  map, messageId, me, names, onToggle,
}: {
  map: ReactionMap | undefined;
  messageId: number | undefined;
  me: number;
  names?: ReadonlyMap<number, string>;
  onToggle: (emoji: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => loadRecentEmoji());
  const addRef = useRef<HTMLButtonElement>(null);
  const chips = reactionChips(map, messageId, me);
  if (messageId == null) return null;
  const byEmoji = map?.[String(messageId)] ?? {};
  const nameFor = (seq: number): string | undefined => (seq === me ? t("나") : names?.get(seq));
  const remember = (emoji: string) => {
    setRecent((list) => {
      const next = pushRecentEmoji(list, emoji);
      saveRecentEmoji(next);
      return next;
    });
  };
  const pick = (emoji: string) => {
    onToggle(emoji);
    remember(emoji);
    setOpen(false);
    setPickerOpen(false);
  };
  const togglePalette = () => {
    setPickerOpen(false);
    setOpen((v) => !v);
  };
  return (
    <div className="reactions">
      {chips.length > 0 && (
        <span className="reaction-chips">
          {chips.map((c) => {
            const label = formatReactionTooltip(c.emoji, byEmoji[c.emoji] ?? [], nameFor);
            return (
              <button key={c.emoji} type="button" title={label} aria-label={label}
                className={`reaction-chip${c.mine ? " mine" : ""}`} onClick={() => onToggle(c.emoji)}>
                <span className="reaction-emoji">{c.emoji}</span>
                <span className="reaction-count">{c.count}</span>
              </button>
            );
          })}
        </span>
      )}
      <button ref={addRef} type="button" className="reaction-add" aria-label={t("리액션")} title={t("리액션")}
        aria-expanded={open || pickerOpen} onClick={togglePalette}>
        <span aria-hidden="true">☺+</span>
      </button>
      {open && (
        <span className="reaction-pop" role="menu" aria-label={t("리액션")}>
          {REACTION_EMOJI.map((e) => (
            <button key={e} type="button" className="reaction-cell" title={e} aria-label={e}
              onClick={() => pick(e)}>{e}</button>
          ))}
          <button type="button" className="reaction-more" onClick={() => { setOpen(false); setPickerOpen(true); }}>
            {t("더보기")}
          </button>
        </span>
      )}
      {pickerOpen && (
        <EmojiPicker recent={recent} onPick={pick} onClose={() => setPickerOpen(false)} anchor={addRef} />
      )}
    </div>
  );
}
