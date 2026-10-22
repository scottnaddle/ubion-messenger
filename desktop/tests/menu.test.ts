import { describe, expect, it, vi } from "vitest";
import { LOCAL_MENU, PortalService, STATIC_MENU, isAllowedPortalPath, menuTarget, parseMenu } from "../electron/core/portal";
import { menuBadge, menuIcon } from "../src/components/Menu";
import * as F from "./fixtures/portal";

const BASE = "https://coco.ubion.co.kr";
describe("menu parsing (/api/userside/baseconfig)", () => {
  const items = parseMenu(F.baseconfig, BASE);
  it("keeps server order, names and sections; categories become section headers", () => {
    expect(items.map((m) => m.name)).toEqual(["홈", "메일", "캘린더", "Works", "게시판", "전자결재", "보고", "근태", "설문", "커뮤니티", "주소록", "클라우드", "ToDO", "회의실/스튜디오", "법인공용차량", "Admin 링크", "사이버연수원"]);
    expect(items.find((m) => m.name === "회의실/스튜디오")).toMatchObject({ section: "예약현황", url: "/app/asset", target: "portal" });
    expect(items.find((m) => m.name === "메일")).toMatchObject({ section: undefined, appName: "mail", url: "/app/mail" });
    expect(items[0]).toMatchObject({ target: "local", local: "home" });
  });
  it("same-host custom link → portal path; other hosts → external", () => {
    expect(items.find((m) => m.name === "법인공용차량")).toMatchObject({ target: "portal", url: "/app/asset/30/list/reservation", custom: true, section: "예약현황" });
    expect(items.find((m) => m.name === "사이버연수원")).toMatchObject({ target: "external", url: "http://hrd.ubion.co.kr/", section: "링크", appName: "link" });
    expect(items.find((m) => m.name === "Admin 링크")?.target).toBe("external");
  });
  it("menuTarget rejects unsafe urls", () => {
    expect(menuTarget("javascript:alert(1)", "", BASE)).toBeNull();
    expect(menuTarget("//evil.com/x", "", BASE)).toBeNull();
    expect(menuTarget("https://u:p@coco.ubion.co.kr/", "", BASE)).toBeNull();
    expect(menuTarget("app/../../x", "", BASE)).toBeNull();
    expect(menuTarget("", "", BASE)).toBeNull();
    expect(menuTarget("", "mail", BASE)).toEqual({ target: "portal", url: "/app/mail" });
    expect(menuTarget("https://coco.ubion.co.kr.evil.com/", "", BASE)?.target).toBe("external");
  });
  it("drops offline / mobile-only entries and tolerates garbage", () => {
    const b = { data: { menuConfigModel: [{ id: 1, seq: 1, name: "A", url: "app/a", status: "offline" }, { id: 2, seq: 2, name: "B", url: "app/b", accessDeviceOption: "MOBILE" }, null, { id: 3, seq: 3, name: "C", url: "app/c", systemMenu: true, appName: "c" }] } };
    expect(parseMenu(b, BASE).map((m) => m.name)).toEqual(["C"]);
    expect(parseMenu(null, BASE)).toEqual([]);
  });
  it("icons and badges", () => {
    expect(menuIcon(items.find((m) => m.name === "법인공용차량")!)).toBe("car");
    expect(menuIcon(items.find((m) => m.name === "메일")!)).toBe("mail");
    expect(menuIcon(items.find((m) => m.name === "사이버연수원")!)).toBe("link");
    const b = { mail: 37, approval: 2, noti: 862 };
    expect(menuBadge(items.find((m) => m.name === "메일")!, b, 3)).toBe(37);
    expect(menuBadge(items.find((m) => m.name === "전자결재")!, b, 3)).toBe(2);
    expect(menuBadge(items.find((m) => m.name === "게시판")!, b, 3)).toBe(3);
    expect(menuBadge(LOCAL_MENU.find((m) => m.appName === "noti")!, b, 3)).toBe(862);
  });
});

describe("PortalService.menu", () => {
  const mk = (ok: boolean) => {
    const fetcher = vi.fn(async (path: string, init?: { method?: string }) => {
      expect(init?.method).toBe("GET");
      return ok && path === "/api/userside/baseconfig" ? { status: 200, text: JSON.stringify(F.baseconfig) } : { status: 500, text: "" };
    });
    return { svc: new PortalService(fetcher, () => undefined), fetcher };
  };
  it("server list (home dropped) + local entries, cached", async () => {
    const { svc, fetcher } = mk(true);
    const r = await svc.menu(BASE);
    expect(r.source).toBe("server");
    expect(r.items.some((m) => m.name === "홈")).toBe(false);
    expect(r.items.slice(-4).map((m) => m.name)).toEqual(["Today", "알림", "대화", "조직도"]);
    await svc.menu(BASE);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(isAllowedPortalPath("/api/userside/baseconfig")).toBe(true);
  });
  it("falls back to static list", async () => {
    const r = await mk(false).svc.menu(BASE);
    expect(r.source).toBe("static");
    expect(r.items.slice(0, STATIC_MENU.length)).toEqual(STATIC_MENU);
  });
});
