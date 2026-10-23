import { describe, expect, it } from "vitest";
import { NAV_ORDER, navForDigit } from "../src/nav";

describe("rail navigation", () => {
  it("has the exact Scott-requested order", () => {
    expect(NAV_ORDER).toEqual(["home", "chats", "mail", "flex", "people", "menu"]);
  });

  it("maps ⌘/Ctrl+1..6 to the rail order", () => {
    expect(navForDigit(1)).toBe("home");
    expect(navForDigit("2")).toBe("chats");
    expect(navForDigit(3)).toBe("mail");
    expect(navForDigit("4")).toBe("flex");
    expect(navForDigit(5)).toBe("people");
    expect(navForDigit("6")).toBe("menu");
  });

  it("ignores out-of-range or non-numeric digits", () => {
    expect(navForDigit(0)).toBeNull();
    expect(navForDigit(7)).toBeNull();
    expect(navForDigit("k")).toBeNull();
    expect(navForDigit("")).toBeNull();
    expect(navForDigit("1.5")).toBeNull();
  });
});
