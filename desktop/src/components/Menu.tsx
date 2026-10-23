import { useEffect, useState } from "react";
import { api, type LockStatus } from "../api";
import { Icon } from "./ui";
import { PubsubModal } from "./PubsubModal";
import { useT } from "../lib/i18n";
import type { ToastFn } from "../App";
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
type Props = { badge: PortalBadge; unreadChats: number; onLocal: (v: LocalView) => void; toast?: ToastFn; onOpenSaved?: () => void };

export function Menu({ badge, unreadChats, onLocal, toast, onOpenSaved }: Props) {
  const t = useT();
  const [items, setItems] = useState<MenuEntry[] | null>(null);
  const [source, setSource] = useState<"server" | "static">("server");
  const [boardNew, setBoardNew] = useState(0);
  const [lock, setLock] = useState<LockStatus | null>(null);
  const [err, setErr] = useState("");
  const [pubsubOpen, setPubsubOpen] = useState(false);

  const load = (force = false) =>
    api().portal.menu(force).then((r) => { setItems(r.items); setSource(r.source); }).catch(() => setErr(t("메뉴를 불러오지 못했습니다")));

  useEffect(() => {
    void load();
    api().portal.get("posts").then((w: any) => {
      const today = new Date().toDateString();
      setBoardNew(((w?.data?.items || []) as BoardPost[]).filter((p) => p.createdAt && new Date(p.createdAt).toDateString() === today).length);
    }).catch(() => undefined);
    api().call<LockStatus>("lock:status").then(setLock).catch(() => undefined);
  }, []);

  const click = (m: MenuEntry) => {
    if (m.target === "local" && m.local) return onLocal(m.local);
    if (m.appName === "mail" || m.appName === "approval") return onLocal(m.appName);
    void api().portal.open(m.url).catch(() => setErr(t("{name}을(를) 열지 못했습니다", { name: m.name })));
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
        <h2>{t("메뉴")}</h2>
        <span className="muted small">{source === "static" ? t("기본 목록(서버 메뉴를 불러오지 못함)") : ""}</span>
        <button className="icon-btn" title={t("새로고침")} onClick={() => void load(true)}><Icon name="refresh" size={18} /></button>
      </div>
      {err && <div className="muted small home-err">{err}</div>}
      {!items && !err && <div className="muted small" style={{ padding: "0 16px" }}>{t("불러오는 중…")}</div>}
      {groups.map((g, i) => (
        <section key={i} className="menu-group">
          {g.title && <h4 className="muted small">{g.title}</h4>}
          <div className="menu-grid">
            {g.list.map((m) => {
              const n = m.appName === "chat" ? unreadChats : menuBadge(m, badge, boardNew);
              return (
                <button key={m.id} className="menu-item" onClick={() => click(m)}
                  title={m.target === "external" ? t("{name} — 외부 브라우저에서 열림", { name: m.name }) : m.target === "local" || m.appName === "mail" || m.appName === "approval" ? t("{name} — 메신저에서 열기", { name: m.name }) : t("{name} — 포털 창에서 열기", { name: m.name })}>
                  <span className="menu-ic"><Icon name={menuIcon(m)} size={22} />{n > 0 && <span className="rail-badge">{n > 99 ? "99+" : n}</span>}</span>
                  <span className="menu-name">{m.name}</span>
                  {m.target === "external" && <span className="menu-ext"><Icon name="external" size={12} /></span>}
                </button>
              );
            })}
          </div>
        </section>
      ))}
      <section className="menu-group">
        <h4 className="muted small">{t("앱")}</h4>
        <div className="menu-grid">
          <button
            className="menu-item"
            disabled={!lock?.enabled}
            title={lock?.enabled ? t("메신저 잠금") : t("설정에서 PIN을 먼저 설정하세요")}
            onClick={() => api().call("lock:lockNow").catch((e) => setErr((e as Error).message))}
          >
            <span className="menu-ic"><Icon name="lock" size={22} /></span>
            <span className="menu-name">{t("메신저 잠금")}</span>
          </button>
          <button className="menu-item" title={t("공지톡 — 여러 사람에게 공지 보내기 / 보낸 공지톡")} onClick={() => setPubsubOpen(true)}>
            <span className="menu-ic"><Icon name="bell" size={22} /></span>
            <span className="menu-name">{t("공지톡")}</span>
          </button>
          {onOpenSaved && (
            <button className="menu-item" title={t("저장한 메시지 · 나중에 알림")} onClick={onOpenSaved}>
              <span className="menu-ic"><Icon name="star" size={22} /></span>
              <span className="menu-name">{t("저장한 메시지")}</span>
            </button>
          )}
        </div>
      </section>
      <section className="menu-group">
        <h4 className="muted small">{t("문의")}</h4>
        <div className="menu-grid">
          <button
            className="menu-item"
            title={t("챗봇 문의 — 외부 브라우저에서 열림")}
            onClick={() => api().openChatBot().catch(() => setErr(t("챗봇 문의를 열지 못했습니다")))}
          >
            <span className="menu-ic"><Icon name="chat" size={22} /></span>
            <span className="menu-name">{t("챗봇 문의")}</span>
            <span className="menu-ext"><Icon name="external" size={12} /></span>
          </button>
        </div>
      </section>
      {pubsubOpen && <PubsubModal toast={toast ?? ((t) => setErr(t))} onClose={() => setPubsubOpen(false)} />}
    </div>
  );
}
