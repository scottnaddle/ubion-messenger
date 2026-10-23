import { describe, expect, it } from "vitest";
import { NAV_ORDER } from "../src/nav";
import {
  navRailTips, nextShowDelay, railLabel, railShortcut, railTipFor, RAIL_TOOLTIP_DELAY_MS,
} from "../src/rail-tooltip";

describe("rail tooltip text", () => {
  it("labels every nav item in NAV_ORDER", () => {
    expect(NAV_ORDER.map((id) => railLabel(id))).toEqual(["홈", "메시지", "메일", "플렉스", "조직도", "앱"]);
    expect(navRailTips({ platform: "darwin" }).map((t) => t.id)).toEqual([...NAV_ORDER]);
  });

  it("formats shortcuts for macOS and other platforms", () => {
    expect(railShortcut("home", "darwin")).toBe("⌘1");
    expect(railShortcut("chats", "darwin")).toBe("⌘2/⌘K");
    expect(railShortcut("mail", "darwin")).toBe("⌘3");
    expect(railShortcut("flex", "darwin")).toBe("⌘4");
    expect(railShortcut("people", "darwin")).toBe("⌘5/⌘N");
    expect(railShortcut("menu", "darwin")).toBe("⌘6");
    expect(railShortcut("settings", "darwin")).toBe("⌘,");
    expect(railShortcut("approval", "darwin")).toBe("");
    expect(railShortcut("home", "win32")).toBe("Ctrl+1");
    expect(railShortcut("chats", "linux")).toBe("Ctrl+2/Ctrl+K");
    expect(railShortcut("people", "win32")).toBe("Ctrl+5/Ctrl+N");
    expect(railShortcut("settings", "linux")).toBe("Ctrl+,");
  });

  it("uses the user name for the profile tooltip", () => {
    expect(railTipFor("profile", { platform: "darwin", name: "홍길동" })).toEqual({ label: "홍길동", shortcut: "" });
    expect(railTipFor("profile", { platform: "darwin" }).label).toBe("프로필");
  });
});

describe("nextShowDelay", () => {
  it("shows instantly while any tooltip is visible", () => {
    expect(nextShowDelay(null, 1000, true)).toBe(0);
    expect(nextShowDelay(0, 1000, true)).toBe(0);
  });

  it("delays the first item", () => {
    expect(nextShowDelay(null, 1000, false)).toBe(RAIL_TOOLTIP_DELAY_MS);
    expect(nextShowDelay(undefined, 1000, false)).toBe(RAIL_TOOLTIP_DELAY_MS);
    expect(nextShowDelay(0, 1000, false)).toBe(RAIL_TOOLTIP_DELAY_MS);
  });

  it("shows instantly when warm after hiding", () => {
    expect(nextShowDelay(1000, 1000, false)).toBe(0);
    expect(nextShowDelay(1000, 1250, false)).toBe(0);
    expect(nextShowDelay(1000, 1300, false)).toBe(0);
  });

  it("cools down outside the warm window", () => {
    expect(nextShowDelay(1000, 1301, false)).toBe(RAIL_TOOLTIP_DELAY_MS);
    expect(nextShowDelay(2000, 1000, false)).toBe(RAIL_TOOLTIP_DELAY_MS);
  });
});
