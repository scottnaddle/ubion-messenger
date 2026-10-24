// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { isMobileUi, useIsCompact } from "../src/lib/compact";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((q: string) => ({
    matches, media: q, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  })) as any;
}

function render(): string {
  const el = document.createElement("div");
  const Probe = () => <span>{useIsCompact() ? "compact" : "wide"}</span>;
  act(() => createRoot(el).render(<Probe />));
  return el.textContent || "";
}

afterEach(() => document.documentElement.classList.remove("ubm-mobile"));

describe("useIsCompact", () => {
  it("is always false on desktop, even in a narrow window", () => {
    stubMatchMedia(true);
    expect(isMobileUi()).toBe(false);
    expect(render()).toBe("wide");
  });
  it("follows the 767px media query in the mobile build", () => {
    document.documentElement.classList.add("ubm-mobile");
    stubMatchMedia(true);
    expect(render()).toBe("compact");
    stubMatchMedia(false);
    expect(render()).toBe("wide");
  });
});
