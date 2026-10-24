import { describe, it, expect } from "vitest";
import { isFlexUrl, isFlexSsoUrl } from "../electron/core/portal-cookies";
import { LOCAL_MENU } from "../electron/core/portal";
import { flexEmailFromUsername, isFlexLoginUrl, FLEX_INBOX, maskFlexLog, parseFlexTodoTotal, flexProgressCountFromText, FLEX_TODO_SEARCH } from "../electron/core/flex";
describe("flex in-app window", () => {
  it("allows flex.team hosts only over https", () => {
    expect(isFlexUrl("https://flex.team/home/todo/inbox")).toBe(true);
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
    expect(LOCAL_MENU.find((m) => m.appName === "flex")?.url).toBe("https://flex.team/home/todo/inbox");
  });
});

describe("flex helpers", () => {
  it("builds company email from portal username", () => {
    expect(flexEmailFromUsername("cwdaddy")).toBe("cwdaddy@ubion.co.kr");
    expect(flexEmailFromUsername("a@b.com")).toBe("a@b.com");
    expect(flexEmailFromUsername("cwdaddy", null)).toBe("");
    expect(flexEmailFromUsername("a@b.com", null)).toBe("a@b.com");
  });
  it("detects the login page", () => {
    expect(isFlexLoginUrl("https://flex.team/auth/login")).toBe(true);
    expect(isFlexLoginUrl(FLEX_INBOX)).toBe(false);
  });
  it("masks secrets in logs", () => {
    expect(maskFlexLog("user@x.com token=abc123")).toContain("<email>");
    expect(maskFlexLog("token=abc123")).toContain("<MASK>");
  });
});

describe("flex pending count", () => {
  it("parses assigned-todos search total", () => {
    expect(parseFlexTodoTotal({ total: 3, assignedTodos: [] })).toBe(3);
    expect(parseFlexTodoTotal({})).toBe(null);
  });
  it("scrapes 진행 (N) from inbox text", () => {
    expect(flexProgressCountFromText("필터\n진행 (3)\n김병하")).toBe(3);
    expect(flexProgressCountFromText("없음")).toBe(null);
  });
  it("uses the SPA search path", () => {
    expect(FLEX_TODO_SEARCH).toContain("/action/v3/todo/assigned-todos/search");
  });
});
