/**
 * ⌘/Ctrl+K command palette + expanded keyboard shortcuts.
 * Pure keymap: no DOM. `matchShortcut` maps a key event to a named action;
 * `isTypingTarget` tells the caller when the key press landed in an editable field
 * (so the app can avoid capturing shortcuts while the user is typing).
 */

export type ShortcutAction =
  | "palette" // ⌘/Ctrl+K — command palette (works even while typing)
  | "settings" // ⌘/Ctrl+,
  | "globalSearch" // ⌘/Ctrl+Shift+F
  | "roomSearch" // ⌘/Ctrl+F
  | "nextUnread" // ⌘/Ctrl+Shift+A
  | "shortcutsHelp" // ⌘/Ctrl+/
  | "people" // ⌘/Ctrl+N
  | "prevRoom" // Alt+↑
  | "nextRoom" // Alt+↓
  | `nav:${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`; // ⌘/Ctrl+1..9

export type ShortcutEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

const NAV_DIGITS = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);

/** Map a keydown event to a named shortcut action, or null when no shortcut matches. */
export function matchShortcut(e: ShortcutEvent): ShortcutAction | null {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (!mod) {
    if (e.altKey && !e.shiftKey && e.key === "ArrowUp") return "prevRoom";
    if (e.altKey && !e.shiftKey && e.key === "ArrowDown") return "nextRoom";
    return null;
  }

  // No ⌘/Ctrl+Alt combos are defined.
  if (e.altKey) return null;

  if (e.shiftKey) {
    if (key === "f") return "globalSearch";
    if (key === "a") return "nextUnread";
    return null;
  }

  if (key === "k") return "palette";
  if (key === ",") return "settings";
  if (key === "/") return "shortcutsHelp";
  if (key === "f") return "roomSearch";
  if (key === "n") return "people";
  if (NAV_DIGITS.has(e.key)) return `nav:${e.key}` as ShortcutAction;
  return null;
}

/** True when the event target is an editable field (input/textarea/select/contenteditable). */
export function isTypingTarget(target: EventTarget | null | undefined): boolean {
  if (!target) return false;
  const el = target as { isContentEditable?: boolean; tagName?: string } | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
