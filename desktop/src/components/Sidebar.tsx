import { useMemo, useState } from "react";
import { api, type Presence, type Room } from "../api";
import { roomTimeLabel } from "../lib/format";
import { roomMatchesFilter } from "../../electron/core/messages";
import type { Toast } from "../App";
import { Avatar, Icon } from "./ui";
import { useT } from "../lib/i18n";

export function Sidebar({
  rooms, activeKey, presence, onOpen, toast,
}: {
  rooms: Room[]; activeKey: string | null; presence: Record<number, Presence>;
  onOpen: (k: string) => void; toast: (t: string, k?: Toast["kind"]) => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "unread" | "dm" | "group">("all");
  const [refreshing, setRefreshing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; room: Room } | null>(null);

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return rooms.filter((r) => {
      if (!roomMatchesFilter(r, filter)) return false;
      return !k || r.name.toLowerCase().includes(k) || r.preview.toLowerCase().includes(k);
    });
  }, [rooms, q, filter]);

  return (
    <aside className="sidebar" onClick={() => setMenu(null)}>
      <div className="side-head">
        <h2>{t("대화")}</h2>
        <button
          className={`icon-btn ${refreshing ? "spin" : ""}`}
          title={t("새로고침")}
          onClick={async () => {
            setRefreshing(true);
            await api().call("rooms:sync").catch(() => undefined);
            setRefreshing(false);
          }}
        >
          <Icon name="refresh" size={18} />
        </button>
      </div>
      <div className="search-box">
        <Icon name="search" size={16} />
        <input id="room-filter" placeholder={t("대화방, 메시지 검색")} value={q} onChange={(e) => setQ(e.target.value)} />
        {q && <button className="icon-btn tiny" onClick={() => setQ("")}><Icon name="close" size={14} /></button>}
      </div>
      <div className="chips">
        {(["all", "unread", "dm", "group"] as const).map((f) => (
          <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
            {{ all: t("전체"), unread: t("안 읽음"), dm: "1:1", group: t("그룹") }[f]}
          </button>
        ))}
      </div>
      <div className="room-list">
        {shown.map((r) => (
          <button
            key={r.key}
            className={`room ${r.key === activeKey ? "active" : ""} ${r.unread ? "has-unread" : ""}`}
            onClick={() => onOpen(r.key)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, room: r });
            }}
          >
            <Avatar name={r.name} src={r.avatar} size={40} presence={r.peerUserId ? presence[r.peerUserId] || "offline" : undefined} />
            <div className="room-body">
              <div className="room-top">
                <span className="room-name">
                  {r.name}
                  {r.memberCount ? <span className="muted"> {r.memberCount}</span> : null}
                  {r.isSelf && <span className="tag">{t("나")}</span>}
                </span>
                <span className="room-time">{roomTimeLabel(r.createdAt)}</span>
              </div>
              <div className="room-bottom">
                <span className="room-preview">{r.preview || "\u00a0"}</span>
                {r.usePin && <span className="pin" title={t("고정됨")}><Icon name="pin" size={13} /></span>}
                {!r.usePush && <span className="muted" title={t("알림 꺼짐")}><Icon name="bellOff" size={13} /></span>}
                {r.unread > 0 && <span className={`badge ${r.usePush ? "" : "quiet"}`}>{r.unread > 999 ? "999+" : r.unread}</span>}
              </div>
            </div>
          </button>
        ))}
        {!shown.length && <div className="empty-list muted">{q ? t("검색 결과가 없습니다") : t("대화가 없습니다")}</div>}
      </div>
      {menu && (
        <div className="ctx" style={{ left: menu.x, top: menu.y }}>
          <button onClick={() => api().call("rooms:pin", menu.room.key, !menu.room.usePin)}>
            {menu.room.usePin ? t("상단 고정 해제") : t("상단 고정")}
          </button>
          <button
            onClick={() =>
              api().setRoomPush(menu.room.key, !menu.room.usePush).catch((e) =>
                toast(t("알림 설정을 변경하지 못했습니다: {message}", { message: (e as Error).message }))
              )
            }
          >
            {menu.room.usePush ? t("알림 끄기") : t("알림 켜기")}
          </button>
          <button onClick={() => api().call("msg:markRead", menu.room.key)}>{t("읽음으로 표시")}</button>
        </div>
      )}
    </aside>
  );
}
