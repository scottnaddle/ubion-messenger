import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "./ui";
import { t as tr, useT } from "../lib/i18n";
import type {
  ApprovalDoc, BoardPost, CalendarEvent, MailItem, PortalBadge, PortalNoti, PortalSummary, PortalWidgetId, PortalWidgetState,
} from "../../electron/core/portal";

type Snap = { summary: PortalSummary | null; badge: PortalBadge; widgets: Partial<Record<PortalWidgetId, PortalWidgetState>> };

/** Same links as the web "투데이 프로필" gadget. */
const CHIP_URL: Record<string, string> = {
  mail: "/app/mail?work=quick&folder=today", survey: "/app/survey", community: "/app/community", report: "/app/report",
  task: "/app/task", approval: "/app/approval/todo", approval2: "/app/approval/todoreception/all", asset: "/app/asset",
};
const chipUrl = (app: string) => (app === "calendar" ? `/app/calendar/daily/${new Date().toLocaleDateString("sv-SE")}` : CHIP_URL[app] || `/app/${app}`);

function ago(s?: string) {
  if (!s) return "";
  const t = new Date(s).getTime();
  if (Number.isNaN(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return tr("방금");
  if (m < 60) return tr("{n}분 전", { n: m });
  if (m < 60 * 24) return tr("{n}시간 전", { n: Math.round(m / 60) });
  return new Date(t).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

const hm = (s: string) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
};

const open = (url: string) => void api().portal.open(url).catch(() => undefined);

function Card({ title, count, webUrl, state, children, isStatic }: {
  title: string; count?: number; webUrl: string; state?: PortalWidgetState; children: React.ReactNode; isStatic?: boolean;
}) {
  const t = useT();
  return (
    <section className="home-card">
      <header>
        <h3>{title}{count != null && <span className="muted"> {count}</span>}</h3>
        <button className="link" onClick={() => open(webUrl)}>{t("웹에서 보기 ▸")}</button>
      </header>
      {state?.error && <div className="muted small home-err">{t("불러오지 못했습니다 · 웹에서 확인하세요")}</div>}
      {!isStatic && !state?.data && !state?.error ? <div className="muted small">{t("불러오는 중…")}</div> : children}
    </section>
  );
}

function Empty({ show, text }: { show: boolean; text: string }) {
  return show ? <div className="muted small home-empty">{text}</div> : null;
}

export function Home({ onLocal, onOpenBot }: { onLocal?: (v: "mail" | "approval" | "flex") => void; onOpenBot?: () => void }) {
  const t = useT();
  const [snap, setSnap] = useState<Snap | null>(null);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const [flexCount, setFlexCount] = useState<number | null>(null);

  useEffect(() => {
    api().portal.get().then((s: Snap) => setSnap(s)).catch(() => undefined);
    api().portal.flexPending().then((r) => setFlexCount(r.count)).catch(() => setFlexCount(null));
    const h = (ev: Event) => {
      const { type, payload } = (ev as CustomEvent).detail;
      if (type === "portalSummary") setSnap((s) => (s ? { ...s, summary: payload } : s));
      else if (type === "portalBadge") setSnap((s) => (s ? { ...s, badge: payload } : s));
      else if (type === "portalWidget") {
        setSnap((s) => (s ? { ...s, widgets: { ...s.widgets, [payload.id]: payload } } : s));
        if (payload.updatedAt) setAt(payload.updatedAt);
      }
    };
    window.addEventListener("ubion:event", h);
    return () => window.removeEventListener("ubion:event", h);
  }, []);

  const refresh = async () => {
    setBusy(true);
    try {
      setSnap(await api().portal.refresh()); setAt(Date.now());
      setFlexCount((await api().portal.flexPending(true)).count);
    } catch { /* card errors shown */ }
    setBusy(false);
  };

  const w = snap?.widgets || {};
  const posts = w.posts?.data as { items: BoardPost[]; total: number } | undefined;
  const todo = w.approvalTodo?.data as { items: ApprovalDoc[]; total: number } | undefined;
  const upcoming = w.approvalUpcoming?.data as { items: ApprovalDoc[]; total: number } | undefined;
  const noti = w.noti?.data as { items: PortalNoti[]; total: number } | undefined;
  const cal = w.calendar?.data as { items: CalendarEvent[]; total: number } | undefined;
  const mail = w.mail?.data as ({ items: MailItem[]; total: number; today?: number }) | undefined;
  const chips = snap?.summary?.chips || [];
  const openFlex = () => (onLocal ? onLocal("flex") : open("https://flex.team/home/todo/inbox"));

  return (
    <div className="home">
      <div className="side-head home-head">
        <h2>{t("홈")}</h2>
        <span className="muted small">{at ? t("마지막 {time}", { time: new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) }) : ""}</span>
        <button className={`icon-btn ${busy ? "spin" : ""}`} title={t("새로고침")} onClick={refresh}><Icon name="refresh" size={18} /></button>
      </div>
      <div className="home-chips">
        {chips.map((c) => (
          <button key={c.appName} className={`chip ${c.count ? "on" : ""}`} onClick={() => {
            if (onLocal && (c.appName === "mail" || c.appName === "approval" || c.appName === "approval2")) {
              onLocal(c.appName === "mail" ? "mail" : "approval");
              return;
            }
            open(chipUrl(c.appName));
          }}>
            {c.gadgetName || c.appName} {c.count}
          </button>
        ))}
        <button className={`chip ${flexCount ? "on" : ""}`} title={t("flex 승인 대기")} onClick={openFlex}>
          {t("flex 승인 대기")} {flexCount == null ? "-" : flexCount}
        </button>
      </div>
      <p className="muted tiny home-hint">{t("항목을 누르면 포털 창에서 열립니다(설정에서 외부 브라우저로 변경 가능). 열면 읽음 처리될 수 있습니다.")}</p>
      <div className="home-grid">
        <section className="home-card">
          <header><h3>{t("내 봇")}</h3></header>
          <p className="muted small">{t("유비온 비서와 1:1로 대화합니다.")}</p>
          <button className="primary" type="button" onClick={() => onOpenBot?.()}>{t("내 봇과 대화")}</button>
        </section>
        <Card title={t("전사게시판 최근글")} webUrl="/app/board" state={w.posts}>
          <ul>{posts?.items.map((p) => (
            <li key={p.id}><button onClick={() => open(p.url)}>
              <span className="tag">{p.boardName}</span> <span className="ellipsis">{p.summary}</span>
              <span className="muted small"> {p.commentsCount ? `💬${p.commentsCount} ` : ""}{p.hasAttach ? "📎 " : ""}{ago(p.createdAt)}</span>
            </button></li>))}</ul>
          <Empty show={!!posts && !posts.items.length} text={t("최근 글이 없습니다")} />
        </Card>
        <Card title={t("flex 승인 대기")} count={flexCount ?? undefined} webUrl="https://flex.team/home/todo/inbox" isStatic>
          <ul><li><button onClick={openFlex}>
            <span className="tag">flex</span> <span className="ellipsis">{t("휴가·근무 승인 요청 보기")}</span>
            <span className="muted small"> · {flexCount == null ? t("건수 확인 중/불가") : t("{n}건", { n: flexCount })}</span>
          </button></li></ul>
        </Card>
        <Card title={t("오늘 일정")} count={cal?.total} webUrl={`/app/calendar/daily/${new Date().toLocaleDateString("sv-SE")}`} state={w.calendar}>
          <ul>{cal?.items.map((e) => (
            <li key={`${e.calendarId}/${e.id}`}><button onClick={() => open(e.url)}>
              <span className="tag">{e.allDay ? t("종일") : `${hm(e.start)}–${hm(e.end)}`}</span> <span className="ellipsis">{e.summary}</span>
              {e.location && <span className="muted small"> · {e.location}</span>}
            </button></li>))}</ul>
          <Empty show={!!cal && !cal.items.length} text={t("오늘 일정이 없습니다")} />
        </Card>
        <Card title={t("결재 대기")} count={todo?.total ?? snap?.badge.approval} webUrl="/app/approval" state={w.approvalTodo}>
          <ul>{todo?.items.map((d) => (
            <li key={d.id}><button onClick={() => open(d.url)}>
              <span className="tag">{d.formName}</span> <span className="ellipsis">{d.title}</span>
              {d.emergency && <span className="badge"> {t("긴급")}</span>}
            </button></li>))}</ul>
          <Empty show={!!todo && !todo.items.length} text={t("결재할 문서가 없습니다")} />
          {!!upcoming?.items.length && <>
            <h4 className="muted small">{t("결재 예정 {n}", { n: upcoming.total })}</h4>
            <ul>{upcoming.items.map((d) => (
              <li key={d.id}><button onClick={() => open(d.url)}><span className="tag">{d.formName}</span> <span className="ellipsis">{d.title}</span></button></li>))}</ul>
          </>}
        </Card>
        <Card title={t("읽지 않은 알림")} count={snap?.badge.noti} webUrl="/app/home" state={w.noti}>
          <ul>{noti?.items.map((n) => (
            <li key={n.id}><button onClick={() => open(n.url)}>
              <span className="tag">{n.category}</span> <span className="ellipsis">{n.message}</span>
              <span className="muted small"> {ago(n.createdAt)}</span>
            </button></li>))}</ul>
          <Empty show={!!noti && !noti.items.length} text={t("알림이 없습니다")} />
        </Card>
        <Card title={t("메일 · 오늘 온 메일")} count={mail?.today ?? snap?.badge.mail} webUrl="/app/mail?work=quick&folder=today" state={w.mail}>
          <ul>{mail?.items.map((m) => (
            <li key={`${m.folderFullName}/${m.id}`}><button onClick={() => open(m.url)} className={m.seen ? "" : "unseen"}>
              {!m.seen && <span className="dot">●</span>} <b>{m.from}</b> · <span className="ellipsis">{m.subject}</span>
            </button></li>))}</ul>
          <Empty show={!!mail && !mail.items.length} text={t("메일이 없습니다")} />
        </Card>
      </div>
    </div>
  );
}
