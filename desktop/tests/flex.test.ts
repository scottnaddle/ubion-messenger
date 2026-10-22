import { describe, it, expect } from "vitest";
import { isFlexUrl, isFlexSsoUrl } from "../electron/core/portal-cookies";
import { LOCAL_MENU } from "../electron/core/portal";
describe("flex in-app window", () => {
  it("allows flex.team hosts only over https", () => {
    expect(isFlexUrl("https://flex.team/home")).toBe(true);
    expect(isFlexUrl("https://app.flex.team/x")).toBe(true);
    expect(isFlexUrl("http://flex.team/")).toBe(false);
    expect(isFlexUrl("https://flex.team.evil.com/")).toBe(false);
    expect(isFlexUrl("https://evilflex.team/")).toBe(false);
    expect(isFlexUrl("https://u:p@flex.team/")).toBe(false);
  });
  it("allows the Google sign-in hop", () => {
    expect(isFlexSsoUrl("https://accounts.google.com/o/oauth2")).toBe(true);
    expect(isFlexSsoUrl("https://google.com/")).toBe(false);
  });
  it("has a flex menu entry", () => {
    expect(LOCAL_MENU.find((m) => m.appName === "flex")?.url).toBe("https://flex.team/home");
  });
});
