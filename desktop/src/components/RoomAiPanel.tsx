import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import {
  loadRoomAi, mergeRoomAiTodos, roomAiFingerprint, roomAiShouldRun, saveRoomAi, toggleRoomAiTodo,
  toRoomAiMessages, RoomAiService, createRoomAiService, ROOM_AI_POLL_MS,
  type RoomAiRecord, type RoomAiRunReason, type RoomAiSource, type RoomAiTodo, type StorageLike,
} from "../lib/room-ai";

const defaultService = createRoomAiService();

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Side panel for implicit room AI. Status stays in this panel ("생각 중…"), never as a chat bubble.
 * The provider runs only while this window is focused and visible.
 */
export function RoomAiPanel({
  roomKey, userId, messages, focused, historyLoading,
  service = defaultService, storage, pollMs = ROOM_AI_POLL_MS, onJump, onOpenBot,
}: {
  roomKey: string;
  userId: number;
  messages: readonly RoomAiSource[];
  focused: boolean;
  historyLoading: boolean;
  service?: RoomAiService;
  storage?: StorageLike | null;
  pollMs?: number;
  /** Row click: scroll the transcript to this todo's source messages. Does not toggle done. */
  onJump?: (todo: RoomAiTodo) => void;
  onOpenBot?: () => void;
}) {
  const t = useT();
  const store = storage === undefined ? browserStorage() : storage;
  const aiMessages = useMemo(() => toRoomAiMessages(messages), [messages]);
  const fingerprint = useMemo(() => roomAiFingerprint(aiMessages), [aiMessages]);
  const [record, setRecord] = useState<RoomAiRecord | null>(null);
  const [phase, setPhase] = useState<"idle" | "thinking" | "error">("idle");
  const [errorText, setErrorText] = useState("");
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const ticketRef = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    setPhase("idle");
    setErrorText("");
    setRecord(store ? loadRoomAi(store, userId, roomKey) : null);
  }, [store, userId, roomKey]);

  const run = useCallback(async (reason: RoomAiRunReason) => {
    if (!store) return;
    const hidden = typeof document !== "undefined" && document.hidden;
    const saved = loadRoomAi(store, userId, roomKey);
    if (!roomAiShouldRun({
      reason, focused, hidden, fingerprint, savedFingerprint: saved?.fingerprint,
    })) return;
    if (reason !== "refresh" && inFlight.current) return;
    const ticket = ++ticketRef.current;
    inFlight.current = true;
    setPhase("thinking");
    setErrorText("");
    try {
      const result = await service.run(roomKey, aiMessages);
      if (ticket !== ticketRef.current) return;
      const next: RoomAiRecord = {
        summary: result.summary,
        todos: mergeRoomAiTodos(saved?.todos ?? [], result.todos),
        updatedAt: Date.now(),
        fingerprint,
      };
      saveRoomAi(store, userId, roomKey, next);
      setRecord(next);
      setPhase("idle");
    } catch (err) {
      if (ticket !== ticketRef.current) return;
      setPhase("error");
      setErrorText(err instanceof Error && err.message ? err.message : "");
    } finally {
      if (ticket === ticketRef.current) inFlight.current = false;
    }
  }, [store, userId, roomKey, focused, fingerprint, aiMessages, service]);

  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (historyLoading) return;
    const onVis = () => {
      const nowHidden = document.hidden;
      setHidden(nowHidden);
      if (nowHidden) {
        ticketRef.current += 1;
        inFlight.current = false;
        setPhase((p) => (p === "thinking" ? "idle" : p));
        return;
      }
      void runRef.current("open");
    };
    document.addEventListener("visibilitychange", onVis);
    const foreground = focused && !document.hidden;
    const stop = () => {
      ticketRef.current += 1;
      inFlight.current = false;
      setPhase((p) => (p === "thinking" ? "idle" : p));
    };
    if (!foreground) {
      return () => {
        stop();
        document.removeEventListener("visibilitychange", onVis);
      };
    }
    void runRef.current("open");
    const timer = window.setInterval(() => { void runRef.current("timer"); }, pollMs);
    return () => {
      stop();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [historyLoading, roomKey, fingerprint, focused, pollMs]);

  const onToggle = (id: string) => {
    if (!store) return;
    const next = toggleRoomAiTodo(store, userId, roomKey, id);
    if (next) setRecord(next);
  };

  const thinking = phase === "thinking";
  const updated = record?.updatedAt
    ? new Date(record.updatedAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";

  return (
    <aside className="room-ai" aria-label={t("방 AI")}>
      <div className="side-head">
        <h3>{t("방 AI")}</h3>
        <button className="link" type="button" disabled={thinking} onClick={() => void run("refresh")}>
          {t("새로고침")}
        </button>
      </div>
      <div className="room-ai-body">
        <div className="room-ai-status" role="status" aria-live="polite">
          {thinking ? (
            <span className="room-ai-thinking">
              {t("생각 중")}
              <span className="bot-status-dots" aria-hidden="true"><i /><i /><i /></span>
            </span>
          ) : phase === "error" ? (
            <span className="room-ai-error">{errorText || t("요약을 만들지 못했습니다.")}</span>
          ) : !focused || hidden ? (
            <span className="muted tiny">{t("앱이 앞에 있을 때만 갱신합니다")}</span>
          ) : (
            <span className="muted tiny">{t("채팅에 메시지를 남기지 않습니다")}</span>
          )}
        </div>
        <h4>{t("요약")}</h4>
        <p className="room-ai-summary">{record?.summary || t("아직 이 방의 요약이 없습니다.")}</p>
        {updated && <div className="muted tiny">{t("최근 갱신 {time}", { time: updated })}</div>}
        <h4>{t("할 일")}</h4>
        <p className="muted tiny room-ai-note">{t("이 기기에만 저장됩니다")}</p>
        {record?.todos.length ? (
          <ul className="room-ai-todos">
            {record.todos.map((todo) => (
              <li key={todo.id} className={`${todo.done ? "done" : ""} ${selectedId === todo.id ? "on" : ""}`}>
                <input
                  type="checkbox"
                  checked={todo.done}
                  aria-label={t("할 일 완료")}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => onToggle(todo.id)}
                />
                <button
                  type="button"
                  className="room-ai-todo-jump"
                  onClick={() => {
                    setSelectedId(todo.id);
                    onJump?.(todo);
                  }}
                >
                  <span className="room-ai-todo-title">{todo.title}</span>
                  {(todo.assignee || todo.due) && (
                    <span className="muted tiny room-ai-todo-meta">
                      {todo.assignee ? t("담당 {name}", { name: todo.assignee }) : ""}
                      {todo.assignee && todo.due ? " · " : ""}
                      {todo.due ? t("마감: {time}", { time: todo.due }) : ""}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">{t("추출된 할 일이 없습니다.")}</p>
        )}
        <button type="button" className="room-ai-bot" onClick={() => onOpenBot?.()}>
          {t("내 봇과 대화")}
        </button>
      </div>
    </aside>
  );
}
