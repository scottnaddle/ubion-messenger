import { describe, expect, it } from "vitest";
import {
  BOT_SETTINGS_SECTIONS,
  botSettingsQuery,
  parseBotSettingsSearch,
  readSettingsSnapshot,
  rendererUrlWithBotSettings,
  selectBotSettingsSection,
  settingsNav,
} from "../src/lib/personal-bot-settings";

describe("personal bot settings layout", () => {
  it("keeps one nav section for the connectors that exist today", () => {
    expect([...BOT_SETTINGS_SECTIONS]).toEqual(["connectors"]);
    expect(new Set(BOT_SETTINGS_SECTIONS).size).toBe(BOT_SETTINGS_SECTIONS.length);
    expect(settingsNav("missing")).toEqual([{ id: "connectors", active: true }]);
    expect(selectBotSettingsSection("connectors")).toBe("connectors");
    expect(settingsNav("connectors").filter((item) => item.active)).toEqual([{ id: "connectors", active: true }]);
  });

  it("builds the child-window query and ignores a bad user id", () => {
    expect(botSettingsQuery(7)).toEqual({ botSettings: "1", userId: "7" });
    const url = new URL(rendererUrlWithBotSettings("http://localhost:5173/?theme=dark", 7));
    expect(url.searchParams.get("theme")).toBe("dark");
    expect(url.searchParams.get("botSettings")).toBe("1");
    expect(url.searchParams.get("userId")).toBe("7");
    expect(parseBotSettingsSearch(url.search)).toEqual({ userId: 7 });
    expect(parseBotSettingsSearch("")).toBeNull();
    expect(parseBotSettingsSearch("?botSettings=1")).toBeNull();
    expect(parseBotSettingsSearch("?botSettings=1&userId=0")).toBeNull();
    expect(parseBotSettingsSearch("?botSettings=1&userId=1.5")).toBeNull();
    expect(parseBotSettingsSearch("?botSettings=0&userId=3")).toBeNull();
  });

  it("keeps connector prefs and google link flags from a settings snapshot", () => {
    expect(readSettingsSnapshot(null)).toBeNull();
    expect(readSettingsSnapshot([])).toBeNull();
    expect(readSettingsSnapshot({
      prefs: { "google-drive": { enabled: false, oauthToken: "  tok  ", extra: true }, bad: null },
      links: {
        "google-drive": { connected: true, account: "  a@b.c  " },
        skip: "nope",
        "google-calendar": { connected: false },
      },
    })).toEqual({
      prefs: { "google-drive": { enabled: false, oauthToken: "tok" } },
      links: {
        "google-drive": { connected: true, account: "a@b.c" },
        "google-calendar": { connected: false },
      },
    });
  });
});
