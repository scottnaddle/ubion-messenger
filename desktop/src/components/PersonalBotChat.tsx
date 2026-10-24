import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { isSendEnter } from "../lib/composer";
import { timeLabel } from "../lib/format";
import { Avatar, Icon } from "./ui";
import {
  createPersonalBotClient,
  loadPersonalBotTurns,
  PERSONAL_BOT_LIVE_ERROR,
  savePersonalBotTurns,
  toPersonalBotWire,
  type PersonalBotClient,
  type PersonalBotStorage,
  type PersonalBotTurn,
} from "../lib/personal-bot";

const defaultClient = createPersonalBotClient();

/**
 * Local personal assistant. Same 1:1 chat chrome as a room, separate session from
 * the 유비온봇 DM and the 나 room (`ubm.personal-bot.v1:*`).
 */
export function PersonalBotChat({
  userId,
  client = defaultClient,
  storage,
}: {
  userId: number;
  client?: PersonalBotClient;
  storage?: PersonalBotStorage;
}) {
  const t = useT();
  const store = storage ?? localStorage;
  const [turns, setTurns] = useState<PersonalBotTurn[]>(() => loadPersonalBotTurns(store, userId));
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const gen = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    gen.current += 1;
    abortRef.current?.abort();
    setTurns(loadPersonalBotTurns(store, userId));
    setDraft("");
    setSending(false);
    setError("");
  }, [store, userId]);

  useEffect(() => {
    savePersonalBotTurns(store, userId, turns);
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, store, userId]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [draft]);

  const send = () => {
    const text = draft.replace(/\s+$/, "").trim();
    if (!text || sending) return;
    const ticket = gen.current;
    const userTurn: PersonalBotTurn = {
      id: `u${Date.now()}`,
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    };
    const next = [...turns, userTurn].slice(-40);
    setDraft("");
    setError("");
    setSending(true);
    setTurns(next);
    const ac = new AbortController();
    abortRef.current = ac;
    void client.reply({ userId, messages: toPersonalBotWire(next), signal: ac.signal }).then((reply) => {
      if (ticket !== gen.current) return;
      const botTurn: PersonalBotTurn = {
        id: `b${Date.now()}`,
        role: "bot",
        text: reply,
        createdAt: new Date().toISOString(),
      };
      setTurns((list) => [...list, botTurn].slice(-40));
    }).catch((e: unknown) => {
      if (ac.signal.aborted || ticket !== gen.current) return;
      const message = e instanceof Error && e.message ? e.message : PERSONAL_BOT_LIVE_ERROR;
      setError(message);
    }).finally(() => {
      if (ticket === gen.current) setSending(false);
    });
  };

  return (
    <section className="chat personal-bot" aria-label={t("내 봇")}>
      <header className="chat-head">
        <Avatar name={t("내 봇")} size={34} />
        <div className="chat-title">
          <div className="name">{t("내 봇")} <span className="tag">{t("비서")}</span></div>
          <div className="sub muted">{t("유비온 비서")}</div>
        </div>
      </header>
      <div className="chat-body">
        <div className="msg-list" ref={listRef}>
          {turns.map((turn, i) => {
            const mine = turn.role === "user";
            const prev = turns[i - 1];
            const next = turns[i + 1];
            const grouped = !!prev && prev.role === turn.role;
            const showTime = !next || next.role !== turn.role || timeLabel(next.createdAt) !== timeLabel(turn.createdAt);
            return (
              <div key={turn.id} className={`msg ${mine ? "mine" : ""} ${grouped ? "grouped" : ""}`}>
                {!mine && <div className="msg-av">{!grouped && <Avatar name={t("내 봇")} size={34} />}</div>}
                <div className="msg-main">
                  {!mine && !grouped && <div className="msg-name">{t("내 봇")}</div>}
                  <div className="msg-line">
                    <div className="bubble">{turn.text}</div>
                    {showTime && turn.createdAt && <div className="msg-meta"><span className="tiny muted">{timeLabel(turn.createdAt)}</span></div>}
                  </div>
                </div>
              </div>
            );
          })}
          {sending && (
            <div className="msg bot-status">
              <div className="msg-av"><Avatar name={t("내 봇")} size={34} /></div>
              <div className="msg-main">
                <div className="msg-name">{t("내 봇")}</div>
                <div className="msg-line">
                  <div className="bubble bot-status-bubble">
                    <span className="bot-status-text">{t("생각 중")}</span>
                    <span className="bot-status-dots" aria-hidden><i /><i /><i /></span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {error && <div className="banner bad" role="alert">{error}</div>}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <button className="icon-btn" type="button" disabled title={t("아직 이 대화에서는 사용할 수 없습니다")} aria-label={t("파일 첨부")}>
          <Icon name="clip" />
        </button>
        <button className="icon-btn" type="button" disabled title={t("아직 이 대화에서는 사용할 수 없습니다")} aria-label={t("화면 캡쳐")}>
          <Icon name="capture" />
        </button>
        <button className="icon-btn" type="button" disabled title={t("아직 이 대화에서는 사용할 수 없습니다")} aria-label={t("이모티콘")}>
          <Icon name="smile" />
        </button>
        <textarea
          ref={taRef}
          rows={1}
          value={draft}
          placeholder={t("메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)")}
          onChange={(e) => setDraft(e.target.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(e) => {
            const native = e.nativeEvent;
            if (isSendEnter({
              key: e.key,
              shiftKey: e.shiftKey,
              isComposing: native.isComposing,
              keyCode: native.keyCode,
              composingRef: composing.current,
            })) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="send-btn" type="submit" disabled={sending || !draft.trim()} title={t("전송")}>
          <Icon name="send" size={18} />
        </button>
      </form>
    </section>
  );
}
