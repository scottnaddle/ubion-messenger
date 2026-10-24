import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { isSendEnter } from "../lib/composer";
import { timeLabel } from "../lib/format";
import { Avatar, Icon } from "./ui";
import {
  connectorStatusList,
  advertisedTools,
  loadConnectorPrefs,
  resolveConnectors,
  saveConnectorPrefs,
  type ConnectorPrefs,
} from "../lib/connectors";
import { executePersonalBotTool, ubionFromBridge } from "../lib/personal-bot-tools";
import {
  createPersonalBotClient,
  loadPersonalBotTurns,
  PERSONAL_BOT_LIVE_ERROR,
  savePersonalBotTurns,
  toPersonalBotWire,
  type PersonalBotClient,
  type PersonalBotStorage,
  type PersonalBotTurn,
  type PersonalBotWireMessage,
} from "../lib/personal-bot";

const defaultClient = createPersonalBotClient();

function connectorLabel(t: (key: string) => string, id: string): string {
  if (id === "ubion-mail") return t("회사 메일");
  if (id === "ubion-approval") return t("결재 대기");
  if (id === "ubion-calendar") return t("오늘 일정");
  if (id === "google-drive") return t("Google Drive");
  if (id === "google-calendar") return t("Google Calendar");
  return id;
}

function connectorStateLabel(t: (key: string) => string, state: "ready" | "off" | "connect-later"): string {
  if (state === "ready") return t("사용 중");
  if (state === "off") return t("꺼짐");
  return t("나중에 연결");
}

function wireTurn(message: PersonalBotWireMessage, id: string): PersonalBotTurn {
  const createdAt = new Date().toISOString();
  if (message.role === "tool") {
    return { id, role: "tool", text: message.content, toolCallId: message.toolCallId, toolName: message.name, createdAt };
  }
  return {
    id,
    role: message.role === "user" ? "user" : "bot",
    text: message.content,
    ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
    createdAt,
  };
}

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
  const [prefs, setPrefs] = useState<ConnectorPrefs>(() => loadConnectorPrefs(store, userId));
  const [connectOpen, setConnectOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const gen = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    gen.current += 1;
    abortRef.current?.abort();
    setTurns(loadPersonalBotTurns(store, userId));
    setPrefs(loadConnectorPrefs(store, userId));
    setDraft("");
    setSending(false);
    setError("");
    setConnectOpen(false);
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
    const resolved = resolveConnectors(prefs);
    const pending = client.run
      ? client.run({
        userId,
        messages: toPersonalBotWire(next),
        tools: advertisedTools(resolved),
        connectorStatus: connectorStatusList(resolved),
        signal: ac.signal,
        execute: (call) => executePersonalBotTool(call, {
          resolved,
          ubion: ubionFromBridge(typeof window === "undefined" ? null : window.ubion),
        }),
      }).then((out) => out.added)
      : client.reply({ userId, messages: toPersonalBotWire(next), signal: ac.signal }).then((reply) => [
        { role: "assistant" as const, content: reply },
      ]);
    void pending.then((added) => {
      if (ticket !== gen.current) return;
      const now = new Date().toISOString();
      const extra = added.map((message, index) => wireTurn(message, `${now}-${index}`));
      setTurns((list) => [...list, ...extra].slice(-40));
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
        <button type="button" className={`icon-btn ${connectOpen ? "on" : ""}`} title={t("비서 연결")} aria-label={t("비서 연결")} onClick={() => setConnectOpen((open) => !open)}>
          <Icon name="gear" size={18} />
        </button>
      </header>
      {connectOpen && (
        <div className="bot-connectors" role="dialog" aria-label={t("비서 연결")}>
          {resolveConnectors(prefs).map((connector) => (
            <label key={connector.id} className="bot-conn">
              <span>{connectorLabel(t, connector.id)}</span>
              <span className="muted tiny">{connectorStateLabel(t, connector.state)}</span>
              <input
                type="checkbox"
                checked={connector.state !== "off"}
                onChange={() => {
                  const enabled = connector.state === "off";
                  const next = { ...prefs, [connector.id]: { ...prefs[connector.id], enabled } };
                  setPrefs(next);
                  saveConnectorPrefs(store, userId, next);
                }}
              />
            </label>
          ))}
        </div>
      )}
      <div className="chat-body">
        <div className="msg-list" ref={listRef}>
          {turns.filter((turn) => (turn.role === "user" || turn.role === "bot") && turn.text.trim()).map((turn, i, shown) => {
            const mine = turn.role === "user";
            const prev = shown[i - 1];
            const next = shown[i + 1];
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
