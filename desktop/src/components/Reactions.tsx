import { useState } from "react";
import { REACTION_EMOJI, type ReactionMap } from "../../electron/core/reactions";
import { reactionChips } from "../lib/reactions";
import { useT } from "../lib/i18n";

/** 이모지 리액션: chips under a message (own reaction highlighted) + a hover "+" button to pick a few emojis. */
export function ReactionBar({
  map, messageId, me, onToggle,
}: {
  map: ReactionMap | undefined;
  messageId: number | undefined;
  me: number;
  onToggle: (emoji: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const chips = reactionChips(map, messageId, me);
  if (messageId == null) return null;
  return (
    <div className="reactions">
      {chips.length > 0 && (
        <span className="reaction-chips">
          {chips.map((c) => (
            <button key={c.emoji} type="button" title={`${c.emoji} ${c.count}`}
              className={`reaction-chip${c.mine ? " mine" : ""}`} onClick={() => onToggle(c.emoji)}>
              <span className="reaction-emoji">{c.emoji}</span>
              <span className="reaction-count">{c.count}</span>
            </button>
          ))}
        </span>
      )}
      <button type="button" className="reaction-add" aria-label={t("리액션")} title={t("리액션")}
        onClick={() => setOpen((v) => !v)}>+</button>
      {open && (
        <span className="reaction-pop">
          {REACTION_EMOJI.map((e) => (
            <button key={e} type="button" className="reaction-cell" onClick={() => { onToggle(e); setOpen(false); }}>{e}</button>
          ))}
        </span>
      )}
    </div>
  );
}
