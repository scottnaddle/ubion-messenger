import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { isSendEnter } from "../lib/composer";
import { timeLabel } from "../lib/format";
import { Avatar, Icon } from "./ui";
import {
  CONNECTORS,
  connectorStatusList,
  connectorStorageKey,
  advertisedTools,
  loadConnectorPrefs,
  resolveConnectors,
  type ConnectorLinkMap,
  type ConnectorPrefs,
} from "../lib/connectors";
import { PersonalBotSettings } from "./PersonalBotSettings";
import { readSettingsSnapshot, type BotSettingsLink } from "../lib/personal-bot-settings";
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

type GoogleLink = BotSettingsLink;

function linkFlags(links: Record<string, GoogleLink>): ConnectorLinkMap {
  const flags: Record<string, boolean> = {};
  for (const [id, link] of Object.entries(links)) {
    if (link.connected) flags[id] = true;
  }
  return flags;
}

function googleBridge() {
  return typeof window === "undefined" ? undefined : window.ubion?.google;
}

function googleExecutors(userId: number): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const google = googleBridge();
  if (!google) return {};
  return {
    google_drive_list: (args: Record<string, unknown>) => google.driveList(userId, {
      query: typeof args.query === "string" ? args.query : undefined,
      mime: typeof args.mime === "string" ? args.mime : typeof args.mimeType === "string" ? args.mimeType : undefined,
      folderId: typeof args.folderId === "string" ? args.folderId : undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
    }),
    google_drive_read: (args: Record<string, unknown>) => google.driveRead(userId, {
      fileId: args.fileId,
      maxChars: args.maxChars,
    }),
    google_calendar_today: () => google.calendarToday(userId),
  };
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
  const [links, setLinks] = useState<Record<string, GoogleLink>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    setLinks({});
    setDraft("");
    setSending(false);
    setError("");
    setSettingsOpen(false);
    let cancel = false;
    const google = googleBridge();
    if (google) {
      void google.status(userId).then((status) => {
        if (cancel) return;
        setLinks(Object.fromEntries(status.connectors.map((item) => [item.id, { connected: item.connected, account: item.account }])));
      }).catch(() => { /* stay connect-later until the next attempt */ });
    }
    return () => { cancel = true; };
  }, [store, userId]);

  useEffect(() => {
    savePersonalBotTurns(store, userId, turns);
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, store, userId]);

  useEffect(() => {
    const off = window.ubion?.personalBotSettings?.onChanged?.((payload) => {
      const user = Number((payload as { userId?: unknown }).userId);
      const snap = readSettingsSnapshot(payload);
      if (!snap || user !== userId) return;
      setPrefs(snap.prefs);
      setLinks(snap.links);
    });
    return () => { off?.(); };
  }, [userId]);

  useEffect(() => {
    const key = connectorStorageKey(userId);
    const onStorage = (e: StorageEvent) => {
      if (!key || e.key !== key) return;
      setPrefs(loadConnectorPrefs(store, userId));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [store, userId]);

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
    const resolved = resolveConnectors(prefs, CONNECTORS, linkFlags(links));
    const pending = client.run
      ? client.run({
        userId,
        messages: toPersonalBotWire(next),
        tools: advertisedTools(resolved),
        connectorStatus: connectorStatusList(resolved),
        signal: ac.signal,
        execute: async (call) => {
          const raw = await executePersonalBotTool(call, {
            resolved,
            ubion: ubionFromBridge(typeof window === "undefined" ? null : window.ubion),
            extra: googleExecutors(userId),
          });
          if (call.name === "google_drive_read" || call.name === "google_drive_list") {
            try {
              const parsed = JSON.parse(raw) as { code?: unknown };
              if (parsed.code === "reconnect") {
                const google = googleBridge();
                const status = google ? await google.status(userId) : null;
                if (status && ticket === gen.current) {
                  setLinks(Object.fromEntries(status.connectors.map((item) => [item.id, { connected: item.connected, account: item.account }])));
                }
              }
            } catch {
              /* keep the tool text */
            }
          }
          return raw;
        },
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

  const openSettings = () => {
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    const opener = window.ubion?.personalBotSettings?.open;
    if (!opener) {
      setSettingsOpen(true);
      return;
    }
    void opener(userId).catch(() => setSettingsOpen(true));
  };

  return (
    <section className="chat personal-bot" aria-label={t("내 봇")}>
      <header className="chat-head">
        <Avatar name={t("내 봇")} size={34} />
        <div className="chat-title">
          <div className="name">{t("내 봇")} <span className="tag">{t("비서")}</span></div>
          <div className="sub muted">{t("유비온 비서")}</div>
        </div>
        <button type="button" className={`icon-btn ${settingsOpen ? "on" : ""}`} title={t("비서 연결")} aria-label={t("비서 연결")} aria-expanded={settingsOpen} onClick={openSettings}>
          <Icon name="gear" size={18} />
        </button>
      </header>
      {settingsOpen ? (
        <div className="bot-settings-panel">
          <PersonalBotSettings
            userId={userId}
            storage={store}
            onClose={() => setSettingsOpen(false)}
            onChanged={(snapshot) => {
              setPrefs(snapshot.prefs);
              setLinks(snapshot.links);
            }}
          />
        </div>
      ) : (
      <>
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
      </>
      )}
    </section>
  );
}
