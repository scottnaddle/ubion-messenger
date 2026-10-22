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

import { sortBrowseHits, sortSearchHits } from "../electron/core/wizard/sort";
import type { WizardHit } from "../electron/core/wizard/types";

function hit(partial: Partial<WizardHit> & { id: string; title: string }): WizardHit {
  return {
    subtitle: "",
    url: "/" + partial.id,
    target: "portal",
    source: "menu",
    aliases: [],
    score: 0,
    reason: "",
    pinned: false,
    usage: 0,
    lastUsedAt: 0,
    ...partial,
  };
}

describe("wizard sort order", () => {
  it("browse: pins (pin order) then recency then frequency", () => {
    const pins = ["pin-b", "pin-a"]; // b before a in pin order
    const hits = [
      hit({ id: "old", title: "Old", usage: 99, lastUsedAt: 1000 }),
      hit({ id: "pin-a", title: "PinA", pinned: true, usage: 1, lastUsedAt: 5000 }),
      hit({ id: "pin-b", title: "PinB", pinned: true, usage: 1, lastUsedAt: 9000 }),
      hit({ id: "recent", title: "Recent", usage: 1, lastUsedAt: 8000 }),
      hit({ id: "freq", title: "Freq", usage: 50, lastUsedAt: 2000 }),
      hit({ id: "fresh", title: "Fresh", usage: 0, lastUsedAt: 0 }),
    ];
    const ids = sortBrowseHits(hits, pins).map((h) => h.id);
    expect(ids.slice(0, 2)).toEqual(["pin-b", "pin-a"]);
    expect(ids[2]).toBe("recent"); // most recent among unpinned
    expect(ids[3]).toBe("freq"); // older than recent but higher usage than old? old lastUsed 1000 < freq 2000
    // recent(8000) > freq(2000) > old(1000) > fresh(0)
    expect(ids).toEqual(["pin-b", "pin-a", "recent", "freq", "old", "fresh"]);
  });

  it("browse: higher frequency wins when same recency", () => {
    const hits = [
      hit({ id: "a", title: "A", usage: 2, lastUsedAt: 100 }),
      hit({ id: "b", title: "B", usage: 9, lastUsedAt: 100 }),
    ];
    expect(sortBrowseHits(hits, []).map((h) => h.id)).toEqual(["b", "a"]);
  });

  it("search: relevance primary, then recency, then frequency", () => {
    const hits = [
      hit({ id: "weak-recent", title: "W", score: 50, lastUsedAt: 9999, usage: 100 }),
      hit({ id: "strong-old", title: "S", score: 90, lastUsedAt: 1, usage: 0 }),
      hit({ id: "strong-recent", title: "SR", score: 90, lastUsedAt: 5000, usage: 1 }),
      hit({ id: "strong-freq", title: "SF", score: 90, lastUsedAt: 5000, usage: 8 }),
    ];
    const ids = sortSearchHits(hits, []).map((h) => h.id);
    expect(ids[0]).toBe("strong-freq"); // same score+recency, higher freq
    expect(ids[1]).toBe("strong-recent");
    expect(ids[2]).toBe("strong-old");
    expect(ids[3]).toBe("weak-recent");
  });

  it("search: equal score → pinned before unpinned, pin order preserved", () => {
    const pins = ["p2", "p1"];
    const hits = [
      hit({ id: "u", title: "U", score: 80, lastUsedAt: 9999, usage: 99 }),
      hit({ id: "p1", title: "P1", score: 80, pinned: true }),
      hit({ id: "p2", title: "P2", score: 80, pinned: true }),
    ];
    expect(sortSearchHits(hits, pins).map((h) => h.id)).toEqual(["p2", "p1", "u"]);
  });

  it("does not auto-pin high-frequency items above recent", () => {
    const hits = [
      hit({ id: "freq", title: "Freq", usage: 100, lastUsedAt: 10 }),
      hit({ id: "recent", title: "Recent", usage: 1, lastUsedAt: 10_000 }),
    ];
    expect(sortBrowseHits(hits, []).map((h) => h.id)).toEqual(["recent", "freq"]);
  });
});
