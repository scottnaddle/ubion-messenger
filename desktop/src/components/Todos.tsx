import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Icon } from "./ui";

export type TodoItem = {
  id: string;
  title: string;
  type: "todo" | "meeting" | "followup";
  status: "open" | "done" | "dismissed";
  due?: string;
  start?: string;
  requesterName?: string;
  assigneeName?: string;
  roomKey?: string;
  source?: { roomKey: string; messageId?: number; snippet?: string };
  confidence: number;
  zoomMeetingId?: string;
  zoomJoinUrl?: string;
  hasZoomPasscode?: boolean;
  origin: "manual" | "auto" | "suggested";
  overdueStage?: number;
};

export type TodoSuggestion = {
  id: string;
  kind: "add" | "complete" | "reschedule";
  draft: Partial<TodoItem> & { title?: string };
  evidenceText: string;
  roomKey: string;
  messageId?: number;
};

type TodoSettings = {
  enabledRooms: string[];
  allRooms: boolean;
  disabledRooms: string[];
  introSeen: boolean;
  remindersEnabled: boolean;
  workStartHour: number;
  workEndHour: number;
  quietDuringMeetings: boolean;
  zoomNotifyMinutes: number[];
  llmFallback: boolean;
  politeMode: boolean;
};

const roomOn = (s: TodoSettings, key: string) =>
  s.allRooms ? !(s.disabledRooms || []).includes(key) : s.enabledRooms.includes(key);

function CollectIntro({ onAll, onPick, onLater }: { onAll: () => void; onPick: () => void; onLater?: () => void }) {
  return (
    <div className="todo-intro" data-testid="todo-intro">
      <div className="todo-intro-title">대화 속 할일, 여기로 모아드려요</div>
      <ul>
        <li>대화에서 <b>요청</b>, <b>마감일</b>, <b>Zoom 회의</b>를 찾아 할일로 모아요.</li>
        <li>확실하면 바로 등록해요(되돌리기 가능). 애매하면 <b>“추가할까요?”</b>로 먼저 물어봐요.</li>
        <li>내용은 <b>이 컴퓨터에만</b> 저장돼요. 서버로 보내지 않아요.</li>
      </ul>
      <div className="todo-intro-actions">
        <button className="primary-btn" onClick={onAll}>모든 채팅방에서 켜기</button>
        <button className="link small" onClick={onPick}>방 골라서 켜기</button>
        {onLater && <button className="link small muted" onClick={onLater}>나중에</button>}
      </div>
    </div>
  );
}

function fmtWhen(iso?: string) {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16);
  }
}

export function Todos({
  rooms,
  onOpenSource,
  toast,
}: {
  rooms: Array<{ key: string; name: string; isSelf?: boolean }>;
  onOpenSource?: (roomKey: string, messageId?: number) => void;
  toast: (m: string) => void;
}) {
  const [tab, setTab] = useState<"open" | "done" | "schedule" | "settings">("open");
  const [items, setItems] = useState<TodoItem[]>([]);
  const [suggestions, setSuggestions] = useState<TodoSuggestion[]>([]);
  const [settings, setSettings] = useState<TodoSettings | null>(null);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [schedule, setSchedule] = useState<{ todos: TodoItem[]; calendar: any } | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  const reload = useCallback(async () => {
    const [list, sug, st] = await Promise.all([
      api().call<TodoItem[]>("todo:list"),
      api().call<TodoSuggestion[]>("todo:suggestions"),
      api().call<TodoSettings>("todo:settings:get"),
    ]);
    setItems(list);
    setSuggestions(sug);
    setSettings(st);
  }, []);

  useEffect(() => {
    void reload();
    return api().onEvent((e) => {
      if (e.type === "todo") void reload();
    });
  }, [reload]);

  useEffect(() => {
    if (tab === "schedule") {
      api()
        .call<{ todos: TodoItem[]; calendar: any }>("todo:schedule")
        .then(setSchedule)
        .catch(() => setSchedule({ todos: [], calendar: null }));
    }
  }, [tab, items]);

  const open = useMemo(() => items.filter((i) => i.status === "open"), [items]);
  const done = useMemo(() => items.filter((i) => i.status === "done"), [items]);

  const add = async () => {
    if (!title.trim()) return;
    await api().call("todo:add", {
      title: title.trim(),
      type: "todo",
      status: "open",
      due: due ? new Date(due).toISOString() : undefined,
      confidence: 1,
      origin: "manual",
    });
    setTitle("");
    setDue("");
    toast("할일을 추가했습니다");
    void reload();
  };

  const roomName = (key?: string) => rooms.find((r) => r.key === key)?.name || key || "";

  return (
    <div className="todos-pane">
      <div className="side-head">
        <h2>할일</h2>
        <div className="seg">
          {(
            [
              ["open", "진행"],
              ["done", "완료"],
              ["schedule", "일정"],
              ["settings", "설정"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {l}
              {k === "open" && open.length ? ` ${open.length}` : ""}
            </button>
          ))}
        </div>
      </div>

      {settings && tab === "open" && !settings.introSeen && !settings.allRooms && settings.enabledRooms.length === 0 && (
        <CollectIntro
          onAll={async () => {
            await api().call("todo:setAllRooms", true);
            setSettings(await api().call("todo:settings:set", { introSeen: true }));
            toast("모든 채팅방에서 할일 자동 수집을 켰어요");
          }}
          onPick={async () => {
            setSettings(await api().call("todo:settings:set", { introSeen: true }));
            setTab("settings");
          }}
          onLater={async () => setSettings(await api().call("todo:settings:set", { introSeen: true }))}
        />
      )}
      {suggestions.length > 0 && tab === "open" && (
        <div className="todo-suggestions">
          {suggestions.slice(0, 5).map((s) => (
            <div key={s.id} className="todo-suggest">
              <div className="grow">
                <div className="small">
                  {s.kind === "complete" ? "완료로 표시할까요?" : "할일로 추가할까요?"}
                </div>
                <div>{s.draft.title || s.evidenceText.slice(0, 60)}</div>
                <div className="muted tiny">{s.evidenceText.slice(0, 80)}</div>
              </div>
              <button
                className="primary small"
                onClick={async () => {
                  await api().call("todo:acceptSuggestion", s.id);
                  toast(s.kind === "complete" ? "완료 처리했습니다" : "할일을 추가했습니다");
                  void reload();
                }}
              >
                수락
              </button>
              <button
                className="link small"
                onClick={async () => {
                  await api().call("todo:rejectSuggestion", s.id);
                  void reload();
                }}
              >
                무시
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === "open" || tab === "done" ? (
        <>
          {tab === "open" && (
            <div className="todo-add">
              <input
                placeholder="새 할일…"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void add()}
              />
              <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
              <button className="primary small" onClick={() => void add()}>
                추가
              </button>
            </div>
          )}
          <ul className="todo-list">
            {(tab === "open" ? open : done).map((it) => (
              <li key={it.id} className={`todo-item ${it.type} ${it.overdueStage ? "overdue" : ""}`}>
                {tab === "open" && (
                  <button
                    className="icon-btn"
                    title="완료"
                    onClick={async () => {
                      await api().call("todo:complete", it.id);
                      toast("완료했습니다");
                      void reload();
                    }}
                  >
                    ○
                  </button>
                )}
                <div className="grow">
                  {editId === it.id ? (
                    <input
                      value={editTitle}
                      autoFocus
                      onChange={(e) => setEditTitle(e.target.value)}
                      onBlur={async () => {
                        if (editTitle.trim() && editTitle !== it.title) {
                          await api().call("todo:update", it.id, { title: editTitle.trim() });
                          void reload();
                        }
                        setEditId(null);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                  ) : (
                    <div
                      className="todo-title"
                      onDoubleClick={() => {
                        setEditId(it.id);
                        setEditTitle(it.title);
                      }}
                    >
                      {it.type === "meeting" ? "📹 " : ""}
                      {it.title}
                      {it.origin === "auto" && <span className="pill tiny">자동</span>}
                    </div>
                  )}
                  <div className="muted tiny">
                    {fmtWhen(it.start || it.due)}
                    {it.requesterName ? ` · ${it.requesterName}` : ""}
                    {it.roomKey ? ` · ${roomName(it.roomKey)}` : ""}
                    {it.hasZoomPasscode ? " · 암호 ••••" : ""}
                  </div>
                  {it.source?.snippet && <div className="muted tiny todo-snip">{it.source.snippet}</div>}
                </div>
                <div className="todo-actions">
                  {it.type === "meeting" && (it.zoomMeetingId || it.zoomJoinUrl) && (
                    <button
                      className="primary small"
                      onClick={() => void api().call("zoom:join", it.id).then(() => toast("Zoom 참가 시도"))}
                    >
                      참가
                    </button>
                  )}
                  {it.source?.roomKey && (
                    <button
                      className="link small"
                      title="원문"
                      onClick={() => onOpenSource?.(it.source!.roomKey, it.source!.messageId)}
                    >
                      원문
                    </button>
                  )}
                  <button
                    className="link small danger"
                    onClick={async () => {
                      await api().call("todo:delete", it.id);
                      void reload();
                    }}
                  >
                    삭제
                  </button>
                </div>
              </li>
            ))}
            {(tab === "open" ? open : done).length === 0 && (
              <li className="muted empty-todo" data-testid="todo-empty">
                {tab === "done" ? (
                  <>아직 완료한 할일이 없어요.</>
                ) : settings && (settings.allRooms || settings.enabledRooms.length > 0) ? (
                  <>
                    <b>아직 할일이 없어요.</b>
                    <br />
                    대화에서 요청·마감·Zoom 회의가 보이면 여기에 모아드릴게요. 위 입력칸으로 직접 추가해도 돼요.
                  </>
                ) : (
                  <>
                    <b>아직 할일이 없어요.</b>
                    <br />
                    자동 수집이 꺼져 있어요. 채팅방 상단의 할일 아이콘이나{" "}
                    <button className="link small" onClick={() => setTab("settings")}>설정</button>에서 켜면 대화 속 할일이 여기로 모여요.
                  </>
                )}
              </li>
            )}
          </ul>
        </>
      ) : null}

      {tab === "schedule" && (
        <div className="todo-schedule">
          <div className="row">
            <h4>할일 일정</h4>
            <button
              className="link small"
              onClick={async () => {
                const p = await api().call<string | null>("todo:exportIcs");
                if (p) toast("ICS 저장됨");
              }}
            >
              .ics 내보내기
            </button>
          </div>
          <ul className="todo-list">
            {(schedule?.todos || open.filter((t) => t.due || t.start)).map((it) => (
              <li key={it.id} className="todo-item">
                <div className="grow">
                  <div>{it.title}</div>
                  <div className="muted tiny">{fmtWhen(it.start || it.due)}</div>
                </div>
              </li>
            ))}
          </ul>
          <h4>포털 캘린더 (읽기)</h4>
          <ul className="todo-list">
            {(schedule?.calendar?.items || []).map((e: any) => (
              <li key={e.id} className="todo-item">
                <div className="grow">
                  <div>{e.summary || "(제목 없음)"}</div>
                  <div className="muted tiny">
                    {fmtWhen(e.start)} {e.location || ""}
                  </div>
                </div>
              </li>
            ))}
            {!schedule?.calendar?.items?.length && <li className="muted empty-todo">오늘 포털 일정이 없거나 아직 불러오는 중…</li>}
          </ul>
        </div>
      )}

      {tab === "settings" && settings && (
        <div className="todo-settings">
          <p className="muted small">
            대화에서 요청·마감·Zoom 회의를 찾아 할일로 모아요. 확실하면 바로 등록(되돌리기 가능), 애매하면 먼저 물어봐요.
            내용은 이 컴퓨터에만 저장돼요. 기본은 꺼짐이에요.
          </p>
          <label className="row" title="켜면 모든 채팅방의 대화에서 할일을 찾아요. 아래 목록에서 방마다 끌 수 있어요.">
            <div>
              <div>모든 채팅방에서 자동 수집</div>
              <div className="muted tiny">켜도 아래에서 방마다 뺄 수 있어요</div>
            </div>
            <input
              type="checkbox"
              className="switch"
              data-testid="all-rooms"
              checked={!!settings.allRooms}
              onChange={async (e) => {
                const on = e.target.checked;
                setSettings(await api().call("todo:setAllRooms", on));
                toast(on ? "모든 채팅방에서 자동 수집을 켰어요" : "고른 채팅방에서만 수집해요");
              }}
            />
          </label>
          <label className="row">
            <div>기한 리마인더</div>
            <input
              type="checkbox"
              className="switch"
              checked={settings.remindersEnabled}
              onChange={async (e) => {
                setSettings(await api().call("todo:settings:set", { remindersEnabled: e.target.checked }));
              }}
            />
          </label>
          <label className="row">
            <div>
              <div>점잖은 알림 문구</div>
              <div className="muted tiny">보스 캐릭터 코믹 톤 대신 중립 문구</div>
            </div>
            <input
              type="checkbox"
              className="switch"
              checked={settings.politeMode}
              onChange={async (e) => {
                setSettings(await api().call("todo:settings:set", { politeMode: e.target.checked }));
              }}
            />
          </label>
          <div className="row">
            <h4>{settings.allRooms ? "수집할 대화방 (끄면 제외)" : "수집할 대화방"}</h4>
            <div>
              <button className="link small" onClick={async () => setSettings(await api().call("todo:enableRooms", rooms.map((r) => r.key), true))}>모두 선택</button>
              {" · "}
              <button className="link small" onClick={async () => setSettings(await api().call("todo:enableRooms", rooms.map((r) => r.key), false))}>모두 해제</button>
            </div>
          </div>
          <ul className="todo-room-list">
            {rooms.map((r) => {
              const on = roomOn(settings, r.key);
              return (
                <li key={r.key} className="row">
                  <div>
                    {r.name} {r.isSelf ? <span className="pill tiny">나</span> : null}
                  </div>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={on}
                    onChange={async (e) => {
                      const on = e.target.checked;
                      setSettings(await api().call("todo:enableRoom", r.key, on));
                      toast(on ? `${r.name}: 자동 수집 켜짐` : `${r.name}: 자동 수집 꺼짐`);
                    }}
                  />
                </li>
              );
            })}
          </ul>
          <button
            className="danger-btn"
            style={{ marginTop: 16 }}
            onClick={async () => {
              if (!confirm("자동/제안으로 추출된 할일·제안을 모두 삭제할까요? (수동 추가분은 유지)")) return;
              await api().call("todo:deleteAllExtracted");
              toast("추출 데이터를 삭제했습니다");
              void reload();
            }}
          >
            추출 데이터 모두 삭제
          </button>
        </div>
      )}
    </div>
  );
}

/** Floating undo toast host helper used by App */
export function useTodoEvents(toast: (m: string, action?: { label: string; onClick: () => void }) => void) {
  useEffect(() => {
    return api().onEvent((e) => {
      if (e.type !== "todo") return;
      const p = e.payload;
      if (p?.type === "auto" && p.item) {
        const id = p.item.id as string;
        toast(`할일 자동 등록: ${p.item.title}`, {
          label: "실행 취소",
          onClick: () => void api().call("todo:undoAuto", id),
        });
      } else if (p?.type === "suggest") {
        toast("할일로 추가할까요? — 할일 탭에서 확인");
      }
    });
  }, [toast]);
}

