import { describe, expect, it, vi } from "vitest";
import {
  CATCHUP_POSTS, MAX_POST_NOTIFY, PortalService, calendarIdsOf, eventsPath, isAllowedPortalPath, isoLocal, parseTodayEvents, planPostNotifications,
  type BoardPost,
} from "../electron/core/portal";
import * as F from "./fixtures/portal";

process.env.TZ = "Asia/Seoul";
const NOW = new Date("2026-10-22T12:00:00+09:00");

describe("오늘 일정 (calendar)", () => {
  it("web-equivalent request", () => {
    expect(calendarIdsOf(F.calendars)).toEqual([312, 11, 10]);
    const p = eventsPath([312, 11, 10], NOW);
    expect(p.startsWith("/api/calendar/event?")).toBe(true);
    const q = new URL(p, "https://x").searchParams;
    expect(q.get("timeMin")).toBe("2026-10-22T00:00:00.000+09:00");
    expect(q.get("timeMax")).toBe("2026-10-22T23:59:59.999+09:00");
    expect(q.getAll("calendarIds[]")).toEqual(["312", "11", "10"]);
    expect(isAllowedPortalPath(p)).toBe(true);
    expect(isAllowedPortalPath("/api/calendar/user/312/calendar")).toBe(true);
    expect(isAllowedPortalPath("/api/calendar/user/me/event/daily")).toBe(false);
    expect(isoLocal(new Date("2026-01-02T03:04:05.006+09:00"))).toBe("2026-01-02T03:04:05.006+09:00");
  });
  it("keeps only today's events, all-day first then by start; drops out-of-range holiday + event ending at 00:00", () => {
    const r = parseTodayEvents(F.events, NOW);
    expect(r.items.map((e) => e.summary)).toEqual(["창립 워크숍", "내방", "사업계획 심의"]);
    expect(r.items[2]).toMatchObject({ location: "대회의실", allDay: false, url: "/app/calendar/312/event/39985" });
    expect(r.items[0].allDay).toBe(true);
    expect(parseTodayEvents({ data: "x" }, NOW).items).toEqual([]);
  });
  it("service: GET only, user calendars then events", async () => {
    const calls: string[] = [];
    const svc = new PortalService(async (path, init) => {
      calls.push(`${init?.method} ${path.split("?")[0]}`);
      const body = path.startsWith("/api/calendar/user/312/calendar") ? F.calendars : path.startsWith("/api/calendar/event") ? F.events : null;
      return body ? { status: 200, text: JSON.stringify(body) } : { status: 404, text: "" };
    }, () => undefined);
    svc.getUserId = () => 312;
    expect((await svc.todayEvents(NOW)).total).toBe(3);
    expect(calls).toEqual(["GET /api/calendar/user/312/calendar", "GET /api/calendar/event"]);
  });
});

const post = (id: number): BoardPost => ({ id, boardId: 7, boardName: "공지", type: "CLASSIC", summary: `글 ${id}`, writerName: "", commentsCount: 0, recommendCount: 0, hasAttach: false, url: `/app/board/7/post/${id}` });

describe("missed board-post notifications", () => {
  it("plan: ≤5 individually, more → newest 5 + summary", () => {
    expect(planPostNotifications([post(1), post(2)], false)).toEqual({ notify: [post(1), post(2)], summary: null });
    const many = [1, 2, 3, 4, 5, 6, 7].map(post);
    const r = planPostNotifications(many, false);
    expect(r.notify.map((p) => p.id)).toEqual([3, 4, 5, 6, 7]);
    expect(r.summary).toEqual({ count: 7, atLeast: false });
    expect(planPostNotifications([1, 2, 3].map(post), true).summary).toEqual({ count: 3, atLeast: true });
    expect(MAX_POST_NOTIFY).toBe(5);
  });

  const mk = (ids: number[]) => {
    const paths: string[] = [];
    const body = { code: "200", data: ids.map((id) => ({ id, boardId: 7, boardName: "공지", type: "CLASSIC", summary: `글 ${id}`, writer: { name: "x" } })) };
    const events: Array<[string, any]> = [];
    const svc = new PortalService(async (path) => {
      paths.push(path);
      return path.startsWith("/api/board/posts/company") ? { status: 200, text: JSON.stringify({ ...body, data: body.data.slice(0, Number(/offset=(\d+)/.exec(path)![1])) }) } : { status: 404, text: "" };
    }, (e, p) => events.push([e, p]));
    return { svc, events, paths };
  };

  it("first-ever run: silent baseline, persists max id", async () => {
    const { svc, events } = mk([910, 909, 908]);
    const saved: number[] = [];
    svc.onPostBaseline = (id) => saved.push(id);
    await svc.refreshLight();
    expect(events.filter((e) => e[0] === "portalNewPost")).toHaveLength(0);
    expect(saved).toEqual([910]);
  });

  it("next start: posts made while closed notify (catch-up fetch of 20)", async () => {
    const { svc, events, paths } = mk([912, 911, 910, 909]);
    svc.persistedMaxPostId = 910;
    const saved: number[] = [];
    svc.onPostBaseline = (id) => saved.push(id);
    await svc.refreshLight();
    expect(paths.find((p) => p.startsWith("/api/board/posts/company"))).toContain(`offset=${CATCHUP_POSTS}`);
    expect(events.filter((e) => e[0] === "portalNewPost").map((e) => e[1].postId)).toEqual([911, 912]);
    expect(events.find((e) => e[0] === "portalNewPostSummary")).toBeUndefined();
    expect(saved).toEqual([912]);
    expect((svc.snapshot().widgets.posts?.data as any).items.length).toBeLessThanOrEqual(5);
    // later polls use the in-memory baseline and the normal 5-post fetch
    await svc.refreshLight();
    expect(paths.filter((p) => p.startsWith("/api/board/posts/company")).pop()).toContain("offset=5");
  });

  it("many missed posts: 5 notifications + 'N개 이상' summary", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => 1000 - i);
    const { svc, events } = mk(ids);
    svc.persistedMaxPostId = 100;
    await svc.refreshLight();
    expect(events.filter((e) => e[0] === "portalNewPost")).toHaveLength(5);
    expect(events.find((e) => e[0] === "portalNewPostSummary")?.[1]).toEqual({ count: 20, atLeast: true });
  });
});
