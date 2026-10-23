import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Department, type Person, type Presence, type SessionUser } from "../api";
import { Avatar, Icon } from "./ui";
import type { Toast } from "../App";
import { useT } from "../lib/i18n";

const ORDER: Record<Presence, number> = { online: 0, busy: 1, away: 2, offline: 3 };

export function People({
  presence, me, onOpenRoom, toast,
}: { presence: Record<number, Presence>; me: SessionUser; onOpenRoom: (k: string) => void; toast: (t: string, k?: Toast["kind"]) => void }) {
  const t = useT();
  const [users, setUsers] = useState<Person[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [q, setQ] = useState("");
  const [dept, setDept] = useState<number | "all" | "online">("all");
  const [sel, setSel] = useState<Person | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [favorites, setFavorites] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api().call<Person[]>("org:users"),
      api().call<Department[]>("org:departments"),
      api().listFavorites().catch(() => [] as Person[]),
    ])
      .then(([u, d, f]) => {
        setUsers(u);
        setDepts(d);
        setFavorites(f);
      })
      .catch((e) => toast(e.message))
      .finally(() => setLoading(false));
  }, [toast]);

  const deptName = useMemo(() => new Map(depts.map((d) => [d.id, d.name])), [depts]);
  const favoriteIds = useMemo(() => new Set(favorites.map((u) => u.userId)), [favorites]);
  const toggleFavorite = useCallback(async (u: Person) => {
    const on = favoriteIds.has(u.userId);
    try {
      if (on) await api().removeFavorite(u.userId);
      else await api().addFavorite(u.userId);
      setFavorites((prev) =>
        on
          ? prev.filter((x) => x.userId !== u.userId)
          : prev.some((x) => x.userId === u.userId) ? prev : [...prev, u]
      );
      toast(on ? t("즐겨찾기에서 삭제했습니다") : t("즐겨찾기에 추가했습니다"), "info");
      // Reconcile in the background; a failed refetch must not surface as a mutation error.
      api().listFavorites().then(setFavorites).catch(() => undefined);
    } catch (e) {
      toast((e as Error).message);
    }
  }, [favoriteIds, toast]);
  const deptCounts = useMemo(() => {
    const m = new Map<number, number>();
    users.forEach((u) => u.departmentIds.forEach((d) => m.set(d, (m.get(d) || 0) + 1)));
    return m;
  }, [users]);

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return users
      .filter((u) => {
        if (dept === "online" && (presence[u.userId] || "offline") === "offline") return false;
        if (typeof dept === "number" && !u.departmentIds.includes(dept)) return false;
        if (!k) return true;
        const dn = u.departmentIds.map((d) => deptName.get(d) || "").join(" ");
        return [u.name, u.position, u.email, dn].some((x) => x.toLowerCase().includes(k));
      })
      .sort((a, b) => ORDER[presence[a.userId] || "offline"] - ORDER[presence[b.userId] || "offline"] || a.name.localeCompare(b.name, "ko"));
  }, [users, q, dept, presence, deptName]);

  const openDm = async (u: Person) => {
    try {
      const room = await api().call<{ key: string }>("rooms:openDirect", u.userId);
      onOpenRoom(room.key);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const createGroup = async () => {
    try {
      const room = await api().call<{ key: string }>("rooms:createGroup", picked);
      setPicked([]);
      onOpenRoom(room.key);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <aside className="sidebar people">
      <div className="side-head"><h2>{t("조직도")}</h2></div>
      <div className="search-box">
        <Icon name="search" size={16} />
        <input autoFocus placeholder={t("이름, 직위, 부서, 이메일")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="dept-select">
        <select value={String(dept)} onChange={(e) => setDept(e.target.value === "all" || e.target.value === "online" ? (e.target.value as "all") : Number(e.target.value))}>
          <option value="all">{t("전체 ({n})", { n: users.length })}</option>
          <option value="online">{t("접속 중")}</option>
          {depts.filter((d) => deptCounts.get(d.id) || depts.some((c) => c.parentId === d.id)).map((d) => (
            <option key={d.id} value={d.id}>{"\u00a0\u00a0".repeat(d.depth || 0)}{d.name}{deptCounts.get(d.id) ? ` (${deptCounts.get(d.id)})` : ""}</option>
          ))}
        </select>
      </div>
      {picked.length > 0 && (
        <div className="group-bar">
          <span>{t("{n}명 선택", { n: picked.length })}</span>
          <button className="link small" onClick={() => setPicked([])}>{t("취소")}</button>
          <button className="primary small" onClick={createGroup}>{t("그룹 대화 만들기")}</button>
        </div>
      )}
      {favorites.length > 0 && (
        <section className="fav-section">
          <h4 className="muted small">{t("즐겨찾기")}</h4>
          {favorites.map((u) => (
            <div
              key={u.userId}
              className={`person fav ${sel?.userId === u.userId ? "active" : ""}`}
              onClick={() => setSel(u)}
              onDoubleClick={() => openDm(u)}
            >
              <Avatar name={u.name} src={u.thumbnail} size={32} presence={presence[u.userId] || "offline"} />
              <div className="room-body">
                <div className="room-name">{u.name} <span className="muted small">{u.position}</span></div>
                <div className="room-preview">{u.departmentIds.map((d) => deptName.get(d)).filter(Boolean).join(", ")}</div>
              </div>
              <button
                className="icon-btn fav-btn on"
                title={t("즐겨찾기 해제")}
                onClick={(e) => { e.stopPropagation(); void toggleFavorite(u); }}
              >
                <Icon name="star" size={16} />
              </button>
            </div>
          ))}
        </section>
      )}
      <div className="room-list">
        {loading && <div className="muted pad small">{t("불러오는 중…")}</div>}
        {shown.map((u) => (
          <div key={u.userId} className={`person ${sel?.userId === u.userId ? "active" : ""}`} onClick={() => setSel(u)} onDoubleClick={() => openDm(u)}>
            <input
              type="checkbox"
              className="pick"
              title={t("그룹 대화에 추가")}
              checked={picked.includes(u.userId)}
              disabled={u.userId === me.id}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setPicked((p) => (e.target.checked ? [...p, u.userId] : p.filter((x) => x !== u.userId)))}
            />
            <Avatar name={u.name} src={u.thumbnail} size={36} presence={presence[u.userId] || "offline"} />
            <div className="room-body">
              <div className="room-name">{u.name} <span className="muted small">{u.position}</span></div>
              <div className="room-preview">{u.departmentIds.map((d) => deptName.get(d)).filter(Boolean).join(", ")}</div>
            </div>
            <button
              className={`icon-btn fav-btn ${favoriteIds.has(u.userId) ? "on" : ""}`}
              title={favoriteIds.has(u.userId) ? t("즐겨찾기 해제") : t("즐겨찾기 추가")}
              onClick={(e) => { e.stopPropagation(); void toggleFavorite(u); }}
            >
              <Icon name="star" size={16} />
            </button>
            <button className="icon-btn" title={t("1:1 대화")} onClick={(e) => { e.stopPropagation(); void openDm(u); }}>
              <Icon name="chat" size={17} />
            </button>
          </div>
        ))}
        {!loading && !shown.length && <div className="empty-list muted">{t("검색 결과가 없습니다")}</div>}
      </div>
      {sel && (
        <div className="profile-card">
          <Avatar name={sel.name} src={sel.thumbnail} size={56} presence={presence[sel.userId] || "offline"} />
          <div className="grow">
            <div className="name">{sel.name} <span className="muted small">{sel.position}</span></div>
            <div className="muted small">{sel.departmentIds.map((d) => deptName.get(d)).filter(Boolean).join(", ")}</div>
            {sel.email && <div className="small">{sel.email}</div>}
            {sel.directTel && <div className="small muted">☎ {sel.directTel}</div>}
          </div>
          <button
            className={`icon-btn fav-btn ${favoriteIds.has(sel.userId) ? "on" : ""}`}
            title={favoriteIds.has(sel.userId) ? t("즐겨찾기 해제") : t("즐겨찾기 추가")}
            onClick={() => void toggleFavorite(sel)}
          >
            <Icon name="star" size={18} />
          </button>
          <button className="primary small" onClick={() => openDm(sel)}>{t("대화하기")}</button>
        </div>
      )}
    </aside>
  );
}
