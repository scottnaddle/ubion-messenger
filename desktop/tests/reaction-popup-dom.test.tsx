// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ReactionPopup } from "../src/components/Reactions";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ReactionPopup select path", () => {
  it("mousedown+click on a palette emoji calls onPick (not onClose first)", async () => {
    const list = document.createElement("div"); list.className = "msg-list"; document.body.appendChild(list);
    const plus = document.createElement("button"); plus.setAttribute("data-reaction-add", "42"); list.appendChild(plus);
    const host = document.createElement("div"); document.body.appendChild(host);
    const onPick = vi.fn(); const onClose = vi.fn();
    const root = createRoot(host);
    await act(async () => { root.render(<ReactionPopup state={{ messageId: 42, mode: "palette" }} onPick={onPick} onMode={() => {}} onClose={onClose} />); });
    const cell = document.querySelector<HTMLButtonElement>(".reaction-cell");
    expect(cell).not.toBeNull();
    await act(async () => {
      cell!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      cell!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      cell!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      cell!.click();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onPick).toHaveBeenCalledWith("👍");
    await act(async () => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onClose).toHaveBeenCalled();
    root.unmount();
  });
});
