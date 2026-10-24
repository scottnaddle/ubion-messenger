// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ChatView reaction select path (integration)", () => {
  it("+ → palette → 👍 sends a toggle and shows a chip", async () => {
    const toggle = vi.fn(async (_r: number, id: number, e: string) => ({ [String(id)]: { [e]: [7] } }));
    const list = vi.fn(async () => ({}));
    const msgs = [{ messageId: 100, message: "hi", sendUserSeq: 9, sendUserName: "A", createdAt: "2026-10-24T08:00:00+09:00", messageType: "TEXT" }];
    const fallback: any = new Proxy(() => Promise.resolve(undefined), {
      get: (_t, k) => (k === "then" ? undefined : fallback),
      apply: () => Promise.resolve(undefined),
    });
    (window as any).ubion = new Proxy({
      reactions: { caps: async () => ({ enabled: true }), list, toggle },
      call: async (ch: string) => (ch === "msg:history" ? msgs : ch === "rooms:members" ? [] : undefined),
      on: () => () => {},
    }, { get: (t: any, k) => (k in t ? t[k] : fallback) });
    Element.prototype.scrollIntoView = () => {};
    (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
    (globalThis as any).IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
    const { ChatView } = await import("../src/components/ChatView");
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    const room = { kind: "room", seq: 27673, roomSeq: 27673, name: "R", key: "room:27673" } as any;
    await act(async () => {
      root.render(<ChatView room={room} me={{ id: 7, repId: 7, name: "me", loginId: "me" } as any} focused toast={vi.fn()} />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const plus = document.querySelector<HTMLButtonElement>("[data-reaction-add='100']");
    expect(plus, host.innerHTML.slice(0, 400)).not.toBeNull();
    await act(async () => { plus!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); plus!.click(); });
    const cell = document.querySelector<HTMLButtonElement>(".reaction-cell");
    expect(cell).not.toBeNull();
    await act(async () => { cell!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); cell!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(toggle).toHaveBeenCalledWith(27673, 100, "👍");
    expect(document.querySelector(".reaction-chip")?.textContent).toContain("👍");
    root.unmount();
    host.remove();
  });

  it("hides add and 리액션 달기 on the author's own bubble, but keeps others' chips", async () => {
    const toggle = vi.fn(async (_r: number, id: number, e: string) => ({ [String(id)]: { [e]: [7] } }));
    const list = vi.fn(async () => ({ 201: { "👍": [9] } }));
    const msgs = [
      { messageId: 100, message: "from-them", sendUserSeq: 9, sendUserName: "A", createdAt: "2026-10-24T08:00:00+09:00", messageType: "TEXT" },
      { messageId: 201, message: "from-me", sendUserSeq: 7, sendUserName: "me", createdAt: "2026-10-24T08:01:00+09:00", messageType: "TEXT" },
      { messageId: 202, message: "also-me", sendUserSeq: 7, sendUserName: "me", createdAt: "2026-10-24T08:02:00+09:00", messageType: "TEXT" },
    ];
    const fallback: any = new Proxy(() => Promise.resolve(undefined), {
      get: (_t, k) => (k === "then" ? undefined : fallback),
      apply: () => Promise.resolve(undefined),
    });
    (window as any).ubion = new Proxy({
      reactions: { caps: async () => ({ enabled: true }), list, toggle },
      call: async (ch: string) => (ch === "msg:history" ? msgs : ch === "rooms:members" ? [] : undefined),
      on: () => () => {},
    }, { get: (t: any, k) => (k in t ? t[k] : fallback) });
    Element.prototype.scrollIntoView = () => {};
    (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
    (globalThis as any).IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
    const { ChatView } = await import("../src/components/ChatView");
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    const room = { kind: "room", seq: 27673, roomSeq: 27673, name: "R", key: "room:27673" } as any;
    await act(async () => {
      root.render(<ChatView room={room} me={{ id: 7, repId: 7, name: "me", loginId: "me" } as any} focused toast={vi.fn()} />);
    });
    const chip = () => [...host.querySelectorAll(".msg.mine")].find((el) => el.textContent?.includes("from-me"))?.querySelector(".reaction-chip");
    const start = Date.now();
    while (!chip()) {
      if (Date.now() - start > 1000) break;
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    }
    expect(host.querySelector("[data-reaction-add='100']")).not.toBeNull();
    expect(host.querySelector("[data-reaction-add='201']")).toBeNull();
    expect(host.querySelector("[data-reaction-add='202']")).toBeNull();
    const ownChip = chip();
    expect(ownChip?.tagName).toBe("SPAN");
    expect(ownChip?.textContent).toContain("👍");
    const emptyOwn = [...host.querySelectorAll(".msg.mine")].find((el) => el.textContent?.includes("also-me"));
    expect(emptyOwn?.querySelector(".reactions")).toBeNull();
    await act(async () => { ownChip!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(toggle).not.toHaveBeenCalled();

    const ownBubble = [...host.querySelectorAll(".msg.mine .bubble")].find((el) => el.textContent?.includes("from-me"));
    await act(async () => {
      ownBubble!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 40 }));
    });
    const ownMenu = ownBubble!.closest(".msg")?.querySelector(".ctx-menu");
    expect(ownMenu?.textContent ?? "").not.toContain("리액션 달기");
    expect(ownMenu?.textContent).toContain("답장");

    const theirBubble = [...host.querySelectorAll(".msg:not(.mine) .bubble")].find((el) => el.textContent?.includes("from-them"));
    await act(async () => {
      theirBubble!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 40 }));
    });
    const theirMenu = theirBubble!.closest(".msg")?.querySelector(".ctx-menu");
    expect(theirMenu?.textContent).toContain("리액션 달기");

    root.unmount();
    host.remove();
  });
});
