import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api, type ChatMessage, type Person, type Room } from "../api";
import { apiRoomSeq, FORWARD_MAX_MEMBERS, FORWARD_SUCCESS_TEXT } from "../../electron/core/forward";
import type { ToastFn } from "../App";
import { Avatar, Icon } from "./ui";

type Tab = "rooms" | "people";
type Confirm = { kind: "room" } | { kind: "members"; ids: number[] };

export function ForwardModal({
  m, toast, onClose,
}: { m: ChatMessage; toast: ToastFn; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("rooms");
  const [q, setQ] = useState("");
  const [rooms, setRooms] = useState<Room[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [room, setRoom] = useState<Room | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api().call<Room[]>("rooms:list"),
      api().call<Person[]>("org:users").catch(() => [] as Person[]),
    ])
      .then(([r, p]) => {
        if (!alive) return;
        setRooms(Array.isArray(r) ? r.filter((x) => x.kind !== "pubsub") : []);
        setPeople(Array.isArray(p) ? p : []);
      })
      .catch((e) => toast((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [toast]);

  const query = q.trim().toLowerCase();
  const shownRooms = useMemo(
    () => rooms.filter((r) => !query || r.name.toLowerCase().includes(query) || r.preview.toLowerCase().includes(query)),
    [rooms, query]
  );
  const shownPeople = useMemo(
    () =>
      people.filter((p) => {
        if (!query) return true;
        return [p.name, p.position, p.email].some((x) => x.toLowerCase().includes(query));
      }),
    [people, query]
  );

  const togglePerson = (id: number) => {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= FORWARD_MAX_MEMBERS) {
        toast(`한 번에 최대 ${FORWARD_MAX_MEMBERS}명까지 전달할 수 있습니다`);
        return prev;
      }
      return [...prev, id];
    });
  };

  const requestSend = () => {
    if (tab === "rooms") {
      if (!room) return toast("전달할 대화방을 선택하세요");
      setConfirm({ kind: "room" });
      return;
    }
    if (!picked.length) return toast("전달할 대상을 선택하세요");
    setConfirm({ kind: "members", ids: picked });
  };

  const send = async (roomType: "single" | "group" = "single") => {
    const cryptIds = m.attach?.cryptId ? [m.attach.cryptId] : [];
    if (!cryptIds.length) return toast("전달할 파일이 없습니다");
    setBusy(true);
    try {
      if (confirm?.kind === "room" && room) {
        await api().forwardToRoom(apiRoomSeq(room), cryptIds);
      } else if (confirm?.kind === "members") {
        await api().forwardToMembers(confirm.ids, cryptIds, confirm.ids.length > 1 ? roomType : "single");
      } else {
        return;
      }
      toast(FORWARD_SUCCESS_TEXT, "info");
      onClose();
    } catch (e) {
      toast(`전달하지 못했습니다: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-back" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        style={{ width: 460 }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        <div className="side-head">
          <h3>파일 전달</h3>
          <button className="icon-btn" title="닫기" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
        {confirm ? (
          <div className="modal-body">
            {confirm.kind === "room" ? (
              <p>{room?.name} 대화방으로 파일을 전달하시겠습니까?</p>
            ) : confirm.ids.length > 1 ? (
              <p>{confirm.ids.length}명에게 파일을 전달합니다. 전송 방식을 선택하세요.</p>
            ) : (
              <p>선택한 사람에게 파일을 전달하시겠습니까?</p>
            )}
            <div className="approval-modal-actions">
              <button className="link" disabled={busy} onClick={() => setConfirm(null)}>취소</button>
              {confirm.kind === "members" && confirm.ids.length > 1 ? (
                <>
                  <button className="primary" disabled={busy} onClick={() => void send("single")}>개별 전송</button>
                  <button className="primary" disabled={busy} onClick={() => void send("group")}>그룹 전송</button>
                </>
              ) : (
                <button className="primary" disabled={busy} onClick={() => void send("single")}>전송</button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="chips" style={{ paddingTop: 8 }}>
              <button className={`chip ${tab === "rooms" ? "on" : ""}`} onClick={() => setTab("rooms")}>대화방</button>
              <button className={`chip ${tab === "people" ? "on" : ""}`} onClick={() => setTab("people")}>조직도</button>
            </div>
            <div className="search-box">
              <Icon name="search" size={16} />
              <input
                autoFocus
                placeholder={tab === "rooms" ? "대화방 검색" : "이름, 직위, 이메일 검색"}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <div className="room-list" style={{ maxHeight: 340, minHeight: 220 }}>
              {loading && <div className="muted small pad">불러오는 중…</div>}
              {!loading && tab === "rooms" && shownRooms.map((r) => (
                <div
                  key={r.key}
                  className={`room ${room?.key === r.key ? "active" : ""}`}
                  role="button"
                  onClick={() => setRoom(r)}
                  onDoubleClick={() => { setRoom(r); setConfirm({ kind: "room" }); }}
                >
                  <Avatar name={r.name} src={r.avatar} size={34} />
                  <div className="room-body">
                    <div className="room-name">{r.name}{r.isSelf && <span className="tag">나</span>}</div>
                    <div className="room-preview">{r.kind === "room" ? "그룹 대화" : r.kind === "pubsub" ? "알림 채널" : "1:1 대화"}</div>
                  </div>
                </div>
              ))}
              {!loading && tab === "people" && shownPeople.map((p) => (
                <div
                  key={p.userId}
                  className={`person ${picked.includes(p.userId) ? "active" : ""}`}
                  role="button"
                  onClick={() => togglePerson(p.userId)}
                >
                  <input type="checkbox" className="pick" checked={picked.includes(p.userId)} readOnly />
                  <Avatar name={p.name} src={p.thumbnail} size={34} />
                  <div className="room-body">
                    <div className="room-name">{p.name} <span className="muted small">{p.position}</span></div>
                    <div className="room-preview">{p.email}</div>
                  </div>
                </div>
              ))}
              {!loading && ((tab === "rooms" && !shownRooms.length) || (tab === "people" && !shownPeople.length)) && (
                <div className="empty-list muted">검색 결과가 없습니다</div>
              )}
            </div>
            <div className="approval-modal-actions" style={{ padding: "0 18px 16px" }}>
              {tab === "people" && picked.length > 0 && <span className="muted small">{picked.length}명 선택</span>}
              <div className="grow" />
              <button className="link" onClick={onClose}>취소</button>
              <button className="primary" onClick={requestSend}>전달</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
