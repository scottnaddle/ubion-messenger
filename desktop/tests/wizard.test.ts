import { describe, expect, it } from "vitest";
import { toChoseong, scoreMatch, editDistance } from "../electron/core/wizard/match";
import { aliasesFor, expandQuery } from "../electron/core/wizard/synonyms";
import { buildIndexFromMenu } from "../electron/core/wizard/index";
import type { MenuEntry } from "../electron/core/portal";

describe("wizard match", () => {
  it("choseong of 회의실", () => {
    expect(toChoseong("회의실")).toBe("ㅎㅇㅅ");
  });
  it("choseong query matches", () => {
    const s = scoreMatch("ㅎㅇㅅ", "회의실/스튜디오", ["회의실"]);
    expect(s.score).toBeGreaterThanOrEqual(70);
  });
  it("synonym 명함", () => {
    const aliases = aliasesFor("명함신청", "/app/approval", "approval");
    expect(aliases.some((a) => a.includes("명함"))).toBe(true);
    const s = scoreMatch("명함", "전자결재", aliasesFor("명함 신청 양식", "/app/approval", "approval"));
    // Direct name match via alias list on a form titled 명함
    expect(scoreMatch("명함", "명함 신청", ["명함신청"]).score).toBeGreaterThanOrEqual(75);
  });
  it("법인 차량 synonym expands", () => {
    const qs = expandQuery("법인 차량");
    expect(qs.some((q) => /차량|배차/.test(q))).toBe(true);
  });
  it("fuzzy small edit", () => {
    expect(editDistance("회의실", "회의실", 2)).toBe(0);
    expect(scoreMatch("회의실", "회의실예약").score).toBeGreaterThanOrEqual(75);
  });
});

describe("wizard index", () => {
  it("builds from menu + deeps", () => {
    const menu: MenuEntry[] = [
      { id: "1", name: "회의실/스튜디오", appName: "asset", url: "/app/asset", custom: false, target: "portal" },
      { id: "2", name: "전자결재", appName: "approval", url: "/app/approval", custom: false, target: "portal" },
      { id: "3", name: "법인 차량 예약", appName: "custom", url: "/app/custom/car", custom: true, target: "portal", section: "예약현황" },
    ];
    const idx = buildIndexFromMenu(menu);
    expect(idx.some((i) => i.title.includes("회의실"))).toBe(true);
    expect(idx.some((i) => i.title.includes("차량"))).toBe(true);
    const car = idx.find((i) => i.title.includes("차량"))!;
    expect(car.aliases.length).toBeGreaterThan(0);
  });
});

describe("wizard works synonyms", () => {
  it("matches 워크스 / works", () => {
    expect(scoreMatch("워크스", "Works (코코 워크스)", ["Works", "워크스"]).score).toBeGreaterThanOrEqual(70);
    expect(expandQuery("코코 워크스").some((q) => /works|워크스/i.test(q))).toBe(true);
  });
  it("법인공용차량 in index", () => {
    const menu: MenuEntry[] = [
      { id: "70", name: "법인공용차량", appName: "custom", url: "/app/asset/30/list/reservation", custom: true, target: "portal", section: "예약현황" },
      { id: "25", name: "Works", appName: "works", url: "/app/works", custom: false, target: "portal" },
    ];
    const idx = buildIndexFromMenu(menu);
    expect(idx.some((i) => i.title.includes("법인공용차량") || i.url.includes("/asset/30"))).toBe(true);
    expect(idx.some((i) => i.appName === "works")).toBe(true);
  });
});
