import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeSavedInput, SavedStore, savedMessageId, SAVED_MAX_ITEMS, type SavedMessage } from "../electron/core/saved";
import type { CacheFs } from "../electron/core/search-cache";

const fakeFs = () => {
  const files = new Map<string, string>();
  const fs: CacheFs & { files: Map<string, string> } = {
    files,
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error("ENOENT");
      return files.get(p)!;
    },
    writeFileSync: (p, d) => void files.set(p, d),
    renameSync: (a, b) => {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    mkdirSync: () => undefined,
    rmSync: (p) => {
      for (const k of [...files.keys()]) if (k.startsWith(p)) files.delete(k);
    },
  };
  return fs;
};

const input = (over: Partial<SavedMessage> = {}) => ({
  roomKey: "room:1",
  roomName: "회의방",
  messageId: 5,
  message: "내일 회의 자료",
  sendUserName: "김하늘",
  createdAt: "2026-10-24T10:00:00.000Z",
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("saved messages: validation", () => {
  it("normalizes the renderer request and rejects missing rooms", () => {
    expect(normalizeSavedInput(input())).toEqual({
      roomKey: "room:1",
      roomName: "회의방",
      messageId: 5,
      message: "내일 회의 자료",
      sendUserName: "김하늘",
      createdAt: "2026-10-24T10:00:00.000Z",
    });
    expect(() => normalizeSavedInput({ ...input(), roomKey: "  " })).toThrow();
    expect(normalizeSavedInput({ roomKey: "room:1", message: "" }).messageId).toBeUndefined();
    expect(normalizeSavedInput({ roomKey: "room:1", messageId: -1 }).messageId).toBeUndefined();
  });

  it("generates unique, prefixed ids", () => {
    const a = savedMessageId(1000);
    const b = savedMessageId(1000);
    expect(a).toMatch(/^s/);
    expect(a).not.toBe(b);
  });
});

describe("saved messages: store (fake fs, client-local)", () => {
  it("persists per user, reloads, and removes", () => {
    const fs = fakeFs();
    const store = new SavedStore("/ud/saved", fs);
    expect(store.for(undefined)).toEqual([]);
    store.for(42);
    const item = store.add(input(), 1700000000000);
    expect(item.id).toMatch(/^s/);
    expect(store.list()).toHaveLength(1);
    store.flush();
    expect([...fs.files.keys()]).toEqual(["/ud/saved/42.json"]);
    // other account has its own list
    expect(store.for(7)).toEqual([]);
    const again = new SavedStore("/ud/saved", fs);
    expect(again.for(42)).toHaveLength(1);
    expect(again.for(42)[0].message).toBe("내일 회의 자료");
    expect(again.remove(item.id)).toBe(true);
    expect(again.remove(item.id)).toBe(false);
    again.flush();
    expect(new SavedStore("/ud/saved", fs).for(42)).toEqual([]);
  });

  it("newest first and capped at SAVED_MAX_ITEMS", () => {
    const fs = fakeFs();
    const store = new SavedStore("/ud/saved", fs, { maxItems: 3 });
    store.for(42);
    store.add(input({ messageId: 1 }));
    store.add(input({ messageId: 2 }));
    store.add(input({ messageId: 3 }));
    store.add(input({ messageId: 4 }));
    expect(store.list().map((m) => m.messageId)).toEqual([4, 3, 2]);
  });

  it("debounces saves", () => {
    vi.useFakeTimers();
    const fs = fakeFs();
    const store = new SavedStore("/ud/saved", fs, { debounceMs: 1000 });
    store.for(1);
    store.add(input());
    store.scheduleSave();
    store.scheduleSave();
    expect(fs.files.size).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(fs.files.size).toBe(1);
  });

  it("treats corrupt files as empty and requires login before add", () => {
    const fs = fakeFs();
    fs.files.set("/ud/saved/42.json", "{oops");
    const store = new SavedStore("/ud/saved", fs);
    expect(store.for(42)).toEqual([]);
    const anon = new SavedStore("/ud/saved", fakeFs());
    expect(() => anon.add(input())).toThrow();
  });
});
