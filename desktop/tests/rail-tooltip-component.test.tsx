// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  RailButton, RailProfile, resetRailTooltipState,
} from "../src/components/RailTooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(node: ReactNode) {
  act(() => root.render(node));
}

function hover(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
}

function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}

function tips() {
  return document.querySelectorAll(".rail-tip");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  resetRailTooltipState();
  document.documentElement.dataset.platform = "darwin";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  resetRailTooltipState();
  delete document.documentElement.dataset.platform;
});

describe("RailTooltip", () => {
  it("delays the first tooltip and switches instantly while warm", () => {
    render(
      <>
        <RailButton id="home">h</RailButton>
        <RailButton id="mail">m</RailButton>
      </>,
    );
    const [home, mail] = container.querySelectorAll("button");

    hover(home);
    advance(299);
    expect(tips()).toHaveLength(0);
    advance(1);
    expect(tips()).toHaveLength(1);
    expect(tips()[0].textContent).toContain("홈");

    hover(mail);
    expect(tips()).toHaveLength(1);
    expect(tips()[0].textContent).toContain("메일");
  });

  it("only ever shows one tooltip across focus and hover", () => {
    render(
      <>
        <RailButton id="home">h</RailButton>
        <RailButton id="mail">m</RailButton>
      </>,
    );
    const [home, mail] = container.querySelectorAll("button");

    act(() => home.focus());
    advance(300);
    expect(tips()).toHaveLength(1);
    expect(tips()[0].textContent).toContain("홈");

    hover(mail);
    expect(tips()).toHaveLength(1);
    expect(tips()[0].textContent).toContain("메일");
  });

  it("Escape cancels a pending tooltip", () => {
    render(<RailButton id="home">h</RailButton>);
    const home = container.querySelector("button")!;

    hover(home);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    advance(400);
    expect(tips()).toHaveLength(0);
  });

  it("resets the warm state when unmounted while open", () => {
    render(<RailButton id="home">h</RailButton>);
    const home = container.querySelector("button")!;

    hover(home);
    advance(300);
    expect(tips()).toHaveLength(1);

    render(null);
    advance(301);
    render(<RailButton id="mail">m</RailButton>);
    const mail = container.querySelector("button")!;

    hover(mail);
    advance(299);
    expect(tips()).toHaveLength(0);
    advance(1);
    expect(tips()).toHaveLength(1);
    expect(tips()[0].textContent).toContain("메일");
  });

  it("hides the tooltip when its item is clicked", () => {
    const onClick = vi.fn();
    render(<RailButton id="settings" onClick={onClick}>s</RailButton>);
    const settings = container.querySelector("button")!;

    hover(settings);
    advance(300);
    expect(tips()).toHaveLength(1);

    act(() => {
      settings.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(tips()).toHaveLength(0);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("describes only the shortcut so the label is not repeated", () => {
    render(<RailButton id="chats">c</RailButton>);
    const chats = container.querySelector("button")!;

    hover(chats);
    advance(300);

    const describedBy = chats.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const described = document.getElementById(describedBy!);
    expect(described?.textContent).toBe(" ⌘2/⌘K");
    expect(described?.textContent).not.toContain("메시지");
  });

  it("renders the profile as a focusable non-button without rail-button styling", () => {
    render(<RailProfile name="홍길동" className="rail-me">p</RailProfile>);

    expect(container.querySelector("button")).toBeNull();
    const profile = container.querySelector(".rail-me") as HTMLElement;
    expect(profile.tagName).toBe("DIV");
    expect(profile.tabIndex).toBe(0);
    expect(profile.className).not.toContain("rail-btn");

    hover(profile);
    advance(300);
    expect(tips()).toHaveLength(1);
    expect(tips()[0].textContent).toContain("홍길동");
  });
});
