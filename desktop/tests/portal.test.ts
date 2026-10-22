import { describe, expect, it, vi } from "vitest";
import {
  PortalService, detectNewPosts, isAllowedPortalPath, maskSecrets, nextDelay, parseApprovalCount, parseApprovals,
  parseMailCount, parseMails, parseNotis, parsePosts, parseSummary, withMailToday, MAX_BACKOFF_MS,
} from "../electron/core/portal";
import * as F from "./fixtures/portal";

describe("portal parsing", () => {
  it("summary chips", () => {
    const s = parseSummary(F.today);
    expect(s.chips).toHaveLength(4);
    expect(s.chips[2]).toEqual({ appName: "calendar", gadgetName: "일정", count: 1 });
    expect(isAllowedPortalPath("/api/home/noti/count")).toBe(true);
    expect(s.chips[3].count).toBe(0);
  });
  it("company posts + deep links", () => {
    const p = parsePosts(F.companyPosts);
    expect(p.total).toBe(42);
    expect(p.items[0]).toMatchObject({ id: 905, boardId: 7, writerName: "관리자", hasAttach: true, url: "/app/board/7/post/905" });
    expect(p.items[1].url).toBe("/app/board/8/post/904/stream");
  });
  it("approvals", () => {
    const a = parseApprovals(F.approvalTodo);
    expect(a.total).toBe(3);
    expect(a.items[0]).toMatchObject({ id: 501, formName: "지출결의서", emergency: true, url: "/app/approval/document/501" });
    expect(parseApprovals(F.approvalUpcoming)).toEqual({ items: [], total: 0 });
    expect(parseApprovalCount(F.approvalCount)).toBe(3);
  });
  it("notis: total = unread, strips html, refuses off-site link", () => {
    const n = parseNotis(F.noti);
    expect(n.total).toBe(15);
    expect(n.items[0]).toMatchObject({ message: "결재 요청", senderName: "김", url: "/link/noti/77" });
    expect(n.items[1].url).toBe("/link/noti/78");
  });
  it("mail list + count", () => {
    const m = parseMails(F.mail);
    expect(m.total).toBe(120);
    expect(m.items[0]).toMatchObject({ id: "1201", from: "박", seen: false, url: "/app/mail?work=read&folder=Inbox&uid=1201" });
    expect(m.items[1].url).toBe("/app/mail?work=read&folder=Inbox%2F%EC%97%85%EB%AC%B4%20A&uid=1200");
    expect(parseMailCount(F.mailCount)).toBe(4);
    expect(parseMailCount({ data: { unreadCount: 2 } })).toBe(2);
  });
  it("live user/today: only web-visible apps, web labels, approval2 kept separate, board dropped", () => {
    const s = parseSummary(F.todayLive);
    expect(s.chips.map((c) => c.appName)).toEqual(["mail", "approval", "approval2", "community", "calendar", "asset", "report", "survey"]);
    expect(s.chips.find((c) => c.appName === "approval2")?.gadgetName).toBe("결재 수신 문서");
    expect(s.chips.some((c) => c.count === 5)).toBe(false);
    expect(parseSummary({ data: { summaries: [{ appName: "task", count: 2 }] } }).chips[0].gadgetName).toBe("담당 업무");
    const m = withMailToday(s, parseMailCount(F.mailCountToday));
    expect(m.chips[0]).toEqual({ appName: "mail", gadgetName: "오늘 온 메일", count: 37 });
    expect(withMailToday(s, undefined)).toBe(s);
  });
  it("live counts", () => {
    expect(parseMailCount(F.mailCountTotal)).toBe(11530);
    expect(parseMailCount(F.homeNotiCount)).toBe(862);
    expect(parseNotis(F.notiUnreadLive).total).toBe(0); // why /api/my/noti/unread is not used for the count
    expect(parseApprovalCount(F.approvalCountLive)).toBe(0);
  });
  it("tolerates garbage", () => {
    expect(parsePosts(null).items).toEqual([]);
    expect(parseMails({ data: "x" }).items).toEqual([]);
    expect(parseSummary({}).chips).toEqual([]);
  });
});

describe("portal safety", () => {
  it("whitelist", () => {
    expect(isAllowedPortalPath("/api/user/today")).toBe(true);
    expect(isAllowedPortalPath("/api/board/posts/company?offset=5&page=0")).toBe(true);
    expect(isAllowedPortalPath("/api/board/12/posts?offset=5")).toBe(true);
    expect(isAllowedPortalPath("/api/login")).toBe(false);
    expect(isAllowedPortalPath("/api/approval/document/1/approve")).toBe(false);
    expect(isAllowedPortalPath("//evil.com/api/user/today")).toBe(false);
    expect(isAllowedPortalPath("https://evil.com/api/user/today")).toBe(false);
    expect(isAllowedPortalPath("/api/user/today/../../login")).toBe(false);
  });
  it("masks secrets", () => {
    const s = maskSecrets('password=hunter2&x=1 {"token":"abc.def"} Cookie: GOSSOcookie=zzz Bearer abc123');
    expect(s).not.toMatch(/hunter2|abc\.def|zzz|abc123/);
  });
  it("backoff caps at 10 min", () => {
    expect(nextDelay(60_000, 0)).toBe(60_000);
    expect(nextDelay(60_000, 2)).toBe(240_000);
    expect(nextDelay(60_000, 9)).toBe(MAX_BACKOFF_MS);
  });
  it("new-post detection baselines first, then reports newer ids", () => {
    const posts = parsePosts(F.companyPosts).items;
    const first = detectNewPosts(posts, null);
    expect(first).toEqual({ fresh: [], maxId: 905 });
    const again = detectNewPosts(posts, 904);
    expect(again.fresh.map((p) => p.id)).toEqual([905]);
    expect(detectNewPosts([], 905)).toEqual({ fresh: [], maxId: 905 });
  });
});

describe("PortalService", () => {
  const routes: Record<string, unknown> = {
    "/api/user/today": F.today, "/api/board/posts/company": F.companyPosts, "/api/approval/todo": F.approvalTodo,
    "/api/approval/upcoming": F.approvalUpcoming, "/api/approval/todo/count": F.approvalCount, "/api/my/noti": F.noti,
    "/api/my/noti/unread": F.noti, "/api/mail/message/gadget": F.mail, "/api/mail/message/count": F.mailCountTotal,
    "/api/mail/message/count?today=on": F.mailCountToday, "/api/home/noti/count": F.homeNotiCount,
  };
  const mk = () => {
    const calls: Array<{ path: string; method?: string }> = [];
    const fetcher = vi.fn(async (path: string, init?: { method?: string }) => {
      calls.push({ path, method: init?.method });
      const body = routes[path] ?? routes[path.split("?")[0]];
      return body ? { status: 200, text: JSON.stringify(body) } : { status: 404, text: "" };
    });
    const events: Array<[string, any]> = [];
    const svc = new PortalService(fetcher, (e, p) => events.push([e, p]));
    return { svc, calls, events, fetcher };
  };

  it("refreshAll emits summary/widgets/badge, GET only", async () => {
    const { svc, calls, events } = mk();
    expect(await svc.refreshAll()).toBe(true);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    const types = events.map((e) => e[0]);
    expect(types).toContain("portalSummary");
    expect(types.filter((t) => t === "portalWidget").length).toBe(5);
    expect(types).not.toContain("portalNewPost");
    expect(svc.snapshot().badge).toEqual({ approval: 3, noti: 862, mail: 37 });
    expect(calls.map((c) => c.path)).toContain("/api/mail/message/count?today=on");
    expect(calls.map((c) => c.path)).not.toContain("/api/mail/message/count");
    expect(svc.snapshot().summary?.chips.find((c) => c.appName === "mail")?.count).toBe(37);
    expect((svc.snapshot().widgets.mail?.data as any).today).toBe(37);
  });
  it("emits portalNewPost after baseline", async () => {
    const { svc, events } = mk();
    await svc.refreshLight();
    routes["/api/board/posts/company"] = { ...F.companyPosts, data: [{ ...F.companyPosts.data[0], id: 906, summary: "새 공지" }, ...F.companyPosts.data] };
    await svc.refreshLight();
    const np = events.filter((e) => e[0] === "portalNewPost");
    expect(np).toHaveLength(1);
    expect(np[0][1]).toMatchObject({ postId: 906, boardId: 7, url: "/app/board/7/post/906" });
    routes["/api/board/posts/company"] = F.companyPosts;
  });
  it("rejects non-whitelisted path without network", async () => {
    const { svc, fetcher } = mk();
    await expect(svc.get("/api/login")).rejects.toThrow(/not allowed/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("dedupes concurrent identical requests", async () => {
    const { svc, fetcher } = mk();
    await Promise.all([svc.get("/api/user/today"), svc.get("/api/user/today")]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("widget failure is isolated and reported", async () => {
    const { svc, events } = mk();
    const saved = routes["/api/my/noti"];
    delete routes["/api/my/noti"];
    expect(await svc.refreshAll()).toBe(false);
    expect(events.find((e) => e[0] === "portalWidget" && e[1].id === "noti")?.[1].error).toMatch(/404/);
    routes["/api/my/noti"] = saved;
  });
});
