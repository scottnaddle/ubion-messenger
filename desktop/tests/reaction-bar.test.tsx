// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReactionBar } from "../src/components/Reactions";
import type { ReactionMap } from "../electron/core/reactions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function renderBar(opts: { map?: ReactionMap; messageId?: number; me?: number; readOnly?: boolean }) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const onToggle = vi.fn();
  const onOpenPicker = vi.fn();
  const onBlocked = vi.fn();
  await act(async () => {
    root.render(
      <ReactionBar
        map={opts.map ?? { 5: { "👍": [2] } }}
        messageId={opts.messageId ?? 5}
        me={opts.me ?? 7}
        readOnly={opts.readOnly}
        onToggle={onToggle}
        onOpenPicker={onOpenPicker}
        onBlocked={onBlocked}
      />,
    );
  });
  return { host, root, onToggle, onOpenPicker, onBlocked };
}

function cleanup(host: HTMLElement, root: Root) {
  act(() => { root.unmount(); });
  host.remove();
}

describe("ReactionBar author affordance", () => {
  it("keeps other people's chips on an own bubble and drops add/toggle", async () => {
    const { host, root, onToggle, onOpenPicker, onBlocked } = await renderBar({
      readOnly: true,
      me: 7,
      map: { 5: { "👍": [9], "❤️": [7, 9] } },
    });
    expect(host.querySelector("[data-reaction-add]")).toBeNull();
    const chips = [...host.querySelectorAll(".reaction-chip")];
    expect(chips.map((c) => c.tagName)).toEqual(["SPAN", "SPAN"]);
    expect(chips.map((c) => c.textContent)).toEqual(["❤️2", "👍1"]);
    expect(chips[0]?.classList.contains("mine")).toBe(true);
    for (const chip of chips) chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onToggle).not.toHaveBeenCalled();
    expect(onOpenPicker).not.toHaveBeenCalled();
    expect(onBlocked).not.toHaveBeenCalled();
    cleanup(host, root);
  });

  it("renders nothing on an own bubble that nobody has reacted to", async () => {
    const { host, root } = await renderBar({ readOnly: true, map: {} });
    expect(host.innerHTML).toBe("");
    cleanup(host, root);
  });

  it("still offers add and toggle on someone else's bubble", async () => {
    const { host, root, onToggle, onOpenPicker } = await renderBar({ readOnly: false });
    const plus = host.querySelector<HTMLButtonElement>("[data-reaction-add='5']");
    expect(plus).not.toBeNull();
    const chip = host.querySelector<HTMLButtonElement>("button.reaction-chip");
    expect(chip?.textContent).toContain("👍");
    await act(async () => { chip!.click(); });
    expect(onToggle).toHaveBeenCalledWith("👍");
    await act(async () => { plus!.click(); });
    expect(onOpenPicker).toHaveBeenCalledWith("palette");
    cleanup(host, root);
  });
});
