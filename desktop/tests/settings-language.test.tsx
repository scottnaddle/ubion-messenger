// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsModal } from "../src/components/SettingsModal";
import type { SessionUser, Settings } from "../src/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (window as any).ubion = {
    platform: "linux",
    call: () => new Promise(() => undefined),
    onUpdate: () => () => undefined,
    theme: { list: () => new Promise(() => undefined) },
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const settings = { serverUrl: "https://x", language: "en", theme: "light", customThemes: [] } as unknown as Settings;
const user = { name: "홍길동", loginId: "hong" } as unknown as SessionUser;

function render(i18nEnabled?: boolean) {
  act(() => {
    root.render(
      <SettingsModal settings={settings} i18nEnabled={i18nEnabled} user={user} onChange={() => undefined} onClose={() => undefined} onLogout={() => undefined} />
    );
  });
}

const hasLanguageSelect = () => [...container.querySelectorAll("select")].some((s) => s.querySelector('option[value="en"]'));

describe("SettingsModal language selector", () => {
  it("is hidden by default (UBM_I18N off)", () => {
    render();
    expect(hasLanguageSelect()).toBe(false);
    expect(container.textContent).not.toContain("언어");
  });

  it("is shown when i18n is enabled", () => {
    render(true);
    expect(hasLanguageSelect()).toBe(true);
  });
});
