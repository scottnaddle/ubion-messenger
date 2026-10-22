import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "./ui";
import type { BoardPost, MenuEntry, PortalBadge } from "../../electron/core/portal";

/** appName → icon (lucide-style set in ui.tsx). Custom links get car/link by name/target. */
const ICON: Record<string, string> = {
  mail: "mail", calendar: "calendar", works: "briefcase", board: "board", approval: "approval", report: "report",
  ehr: "clock", survey: "survey", community: "community", contact: "contact", webfolder: "cloud", todo: "todo",
  asset: "door", home: "sun", noti: "bell", chat: "chat", org: "people", link: "link",
};
export function menuIcon(m: MenuEntry): string {
  if (ICON[m.appName] && m.appName !== "link") return ICON[m.appName];
  if (/차량|car/i.test(m.name)) return "car";
  if (/\/app\/asset\b/.test(m.url)) return "door";
  return "link";
}

/** Counts we already have (홈 tab sources): 메일=오늘 온 메일, 결재=결재할 문서, 알림=unread noti, 게시판=today's new company posts. */
export function menuBadge(m: MenuEntry, badge: PortalBadge, boardNew: number): number {
  if (m.target === "portal" && m.appName === "mail") return badge.mail;
  if (m.target === "portal" && m.appName === "approval") return badge.approval;
  if (m.target === "portal" && m.appName === "board") return boardNew;
  if (m.appName === "noti") return badge.noti;
  return 0;
}

type LocalView = "home" | "chats" | "people" | "mail" | "approval";
type Props = { badge: PortalBadge; unreadChats: number; onLocal: (v: LocalView) => void };

export function Menu({ badge, unreadChats, onLocal }: Props) {
  const [items, setItems] = useState<MenuEntry[] | null>(null);
  const [source, setSource] = useState<"server" | "static">("server");
  const [boardNew, setBoardNew] = useState(0);
  const [err, setErr] = useState("");

  const load = (force = false) =>
    api().portal.menu(force).then((r) => { setItems(r.items); setSource(r.source); }).catch(() => setErr("메뉴를 불러오지 못했습니다"));

  useEffect(() => {
    void load();
    api().portal.get("posts").then((w: any) => {
      const today = new Date().toDateString();
      setBoardNew(((w?.data?.items || []) as BoardPost[]).filter((p) => p.createdAt && new Date(p.createdAt).toDateString() === today).length);
    }).catch(() => undefined);
  }, []);

  const click = (m: MenuEntry) => {
    if (m.target === "local" && m.local) return onLocal(m.local);
    if (m.appName === "mail" || m.appName === "approval") return onLocal(m.appName);
    void api().portal.open(m.url).catch(() => setErr(`${m.name}을(를) 열지 못했습니다`));
  };

  const groups: Array<{ title?: string; list: MenuEntry[] }> = [];
  for (const m of items || []) {
    const g = groups[groups.length - 1];
    if (g && g.title === m.section) g.list.push(m);
    else groups.push({ title: m.section, list: [m] });
  }

  return (
    <div className="home menu-view">
      <div className="side-head home-head">
        <h2>메뉴</h2>
        <span className="muted small">{source === "static" ? "기본 목록(서버 메뉴를 불러오지 못함)" : ""}</span>
        <button className="icon-btn" title="새로고침" onClick={() => void load(true)}><Icon name="refresh" size={18} /></button>
      </div>
      {err && <div className="muted small home-err">{err}</div>}
      {!items && !err && <div className="muted small" style={{ padding: "0 16px" }}>불러오는 중…</div>}
      {groups.map((g, i) => (
        <section key={i} className="menu-group">
          {g.title && <h4 className="muted small">{g.title}</h4>}
          <div className="menu-grid">
            {g.list.map((m) => {
              const n = m.appName === "chat" ? unreadChats : menuBadge(m, badge, boardNew);
              return (
                <button key={m.id} className="menu-item" onClick={() => click(m)}
                  title={m.target === "external" ? `${m.name} — 외부 브라우저에서 열림` : m.target === "local" || m.appName === "mail" || m.appName === "approval" ? `${m.name} — 메신저에서 열기` : `${m.name} — 포털 창에서 열기`}>
                  <span className="menu-ic"><Icon name={menuIcon(m)} size={22} />{n > 0 && <span className="rail-badge">{n > 99 ? "99+" : n}</span>}</span>
                  <span className="menu-name">{m.name}</span>
                  {m.target === "external" && <span className="menu-ext"><Icon name="external" size={12} /></span>}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
