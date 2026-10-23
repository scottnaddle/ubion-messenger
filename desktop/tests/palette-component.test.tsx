// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CommandPalette } from "../src/components/CommandPalette";
import type { PaletteItem } from "../src/lib/palette";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const item = (id: string, label: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({ id, kind: "screen", label, ...extra });

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CommandPalette", () => {
  const items = [
    item("view:chats", "메시지", { view: "chats" }),
    item("view:mail", "메일", { view: "mail" }),
    item("room:1", "결재 TF", { kind: "room", roomKey: "room:1" }),
    item("person:7", "김하늘", { kind: "person", userId: 7 }),
  ];

  it("shows items and filters by query (초성)", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(<CommandPalette items={items} onPick={onPick} onClose={onClose} />);
    });
    expect(document.body.textContent).toContain("메시지");
    expect(document.body.textContent).toContain("메일");

    const input = document.querySelector<HTMLInputElement>(".palette input")!;
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "ㄱㅈ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const labels = [...document.querySelectorAll(".palette-label")].map((e) => e.textContent);
    expect(labels).toEqual(["결재 TF"]);
  });

  it("navigates with arrows and activates with Enter", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(<CommandPalette items={items} onPick={onPick} onClose={onClose} />);
    });
    const input = document.querySelector<HTMLInputElement>(".palette input")!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.querySelector(".palette-item.selected")?.textContent).toContain("메일");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "view:mail" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape and on backdrop click", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<CommandPalette items={items} onPick={() => undefined} onClose={onClose} />);
    });
    const input = document.querySelector<HTMLInputElement>(".palette input")!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      document.querySelector<HTMLDivElement>(".palette-back")!.click();
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
