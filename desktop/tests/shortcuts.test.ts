import { describe, expect, it } from "vitest";
import { isTypingTarget, matchShortcut, type ShortcutEvent } from "../src/lib/shortcuts";

const ev = (p: Partial<ShortcutEvent>): ShortcutEvent => ({
  key: "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...p,
});

describe("matchShortcut", () => {
  it("maps ⌘/Ctrl+K to the palette on both modifiers", () => {
    expect(matchShortcut(ev({ key: "k", ctrlKey: true }))).toBe("palette");
    expect(matchShortcut(ev({ key: "k", metaKey: true }))).toBe("palette");
    expect(matchShortcut(ev({ key: "K", ctrlKey: true }))).toBe("palette");
  });

  it("maps settings, searches, and navigation", () => {
    expect(matchShortcut(ev({ key: ",", ctrlKey: true }))).toBe("settings");
    expect(matchShortcut(ev({ key: "f", ctrlKey: true }))).toBe("roomSearch");
    expect(matchShortcut(ev({ key: "f", ctrlKey: true, shiftKey: true }))).toBe("globalSearch");
    expect(matchShortcut(ev({ key: "a", ctrlKey: true, shiftKey: true }))).toBe("nextUnread");
    expect(matchShortcut(ev({ key: "/", ctrlKey: true }))).toBe("shortcutsHelp");
    expect(matchShortcut(ev({ key: "n", ctrlKey: true }))).toBe("people");
  });

  it("maps ⌘/Ctrl+1..9 to nav actions", () => {
    for (let d = 1; d <= 9; d++) {
      expect(matchShortcut(ev({ key: String(d), ctrlKey: true }))).toBe(`nav:${d}`);
    }
  });

  it("maps Alt+↑/↓ to prev/next room", () => {
    expect(matchShortcut(ev({ key: "ArrowUp", altKey: true }))).toBe("prevRoom");
    expect(matchShortcut(ev({ key: "ArrowDown", altKey: true }))).toBe("nextRoom");
  });

  it("returns null for non-shortcut keys", () => {
    expect(matchShortcut(ev({ key: "Enter" }))).toBeNull();
    expect(matchShortcut(ev({ key: "ArrowDown" }))).toBeNull();
    expect(matchShortcut(ev({ key: "k" }))).toBeNull();
    expect(matchShortcut(ev({ key: "1" }))).toBeNull();
    expect(matchShortcut(ev({ key: "a", ctrlKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: "k", ctrlKey: true, altKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: "ArrowUp", altKey: true, shiftKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: "k", ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});

describe("isTypingTarget", () => {
  it("detects editable fields", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "textarea" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("ignores buttons, divs, and null targets", () => {
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget({ tagName: "DIV" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget({} as unknown as EventTarget)).toBe(false);
  });
});
