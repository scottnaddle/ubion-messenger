import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { stubBotReply } from "../lib/personal-bot";

type Turn = { id: string; role: "user" | "bot"; text: string };

const GREETING = "[스텁] 안녕하세요. 저는 유비온 비서입니다. 메일·결재·일정은 아직 연결 전이고, 지금은 이 대화만 됩니다.";

function storageKey(userId: number): string {
  return `ubm.personal-bot.v1:${userId}`;
}

function loadTurns(userId: number): Turn[] {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return [{ id: "greet", role: "bot", text: GREETING }];
    const data = JSON.parse(raw) as Turn[];
    if (!Array.isArray(data) || !data.length) return [{ id: "greet", role: "bot", text: GREETING }];
    return data.filter((turn) => turn && (turn.role === "user" || turn.role === "bot") && typeof turn.text === "string").slice(-40);
  } catch {
    return [{ id: "greet", role: "bot", text: GREETING }];
  }
}

/**
 * Local personal assistant. Separate from the 유비온봇 DM and the 나 room.
 * Replies stay on this device under ubm.personal-bot.v1:*.
 */
export function PersonalBotChat({ userId }: { userId: number }) {
  const t = useT();
  const [turns, setTurns] = useState<Turn[]>(() => loadTurns(userId));
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTurns(loadTurns(userId));
  }, [userId]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(userId), JSON.stringify(turns));
    } catch {
      /* best-effort */
    }
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, userId]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const now = Date.now();
    setDraft("");
    setTurns((list) => [
      ...list,
      { id: `u${now}`, role: "user", text },
      { id: `b${now}`, role: "bot", text: stubBotReply(text) },
    ]);
  };

  return (
    <section className="assistant" aria-label={t("내 봇")}>
      <header className="chat-head">
        <div className="chat-title">
          <div className="name">{t("내 봇")} <span className="tag">{t("비서")}</span></div>
          <div className="sub muted">{t("유비온 비서 · 이 기기의 스텁 대화")}</div>
        </div>
      </header>
      <div className="assistant-log" ref={logRef}>
        {turns.map((turn) => (
          <div key={turn.id} className={`assistant-row ${turn.role === "user" ? "mine" : ""}`}>
            <div className="assistant-bubble">{turn.text}</div>
          </div>
        ))}
      </div>
      <form
        className="assistant-compose"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          value={draft}
          placeholder={t("내 봇에게 메시지")}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="primary" type="submit" disabled={!draft.trim()}>{t("보내기")}</button>
      </form>
    </section>
  );
}
