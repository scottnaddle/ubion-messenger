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
  });
});
