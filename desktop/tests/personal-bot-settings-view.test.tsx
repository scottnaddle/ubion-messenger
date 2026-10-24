// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { PersonalBotSettings } from "../src/components/PersonalBotSettings";
import { CONNECTOR_STORAGE_PREFIX, type ConnectorPrefs } from "../src/lib/connectors";
import type { PersonalBotStorage } from "../src/lib/personal-bot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function memory(): PersonalBotStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
  };
}

async function renderSettings(storage: PersonalBotStorage, onChanged?: (prefs: ConnectorPrefs) => void) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <PersonalBotSettings
        userId={7}
        storage={storage}
        onClose={() => undefined}
        onChanged={onChanged ? (snap) => onChanged(snap.prefs) : undefined}
      />,
    );
  });
  return { host, root };
}

describe("PersonalBotSettings", () => {
  it("shows the connector section instead of a flat menu", async () => {
    const { host, root } = await renderSettings(memory());
    expect(host.querySelector(".bot-connectors")).toBeNull();
    expect(host.querySelector(".bot-settings-nav button[aria-current='page']")?.textContent).toBe("커넥터");
    expect(host.textContent).toContain("내 봇 설정");
    expect(host.textContent).toContain("회사 메일");
    expect(host.textContent).toContain("나중에 연결");
    expect(host.textContent).not.toContain("일반");
    const connect = [...host.querySelectorAll("button")].find((button) => button.textContent === "연결");
    await act(async () => { connect!.click(); });
    expect(host.textContent).toContain("Google 연결은 앱에서만 사용할 수 있습니다.");
    await act(async () => { root.unmount(); });
  });

  it("writes the same connector storage key when a toggle changes", async () => {
    const storage = memory();
    let saved: ConnectorPrefs | undefined;
    const { host, root } = await renderSettings(storage, (prefs) => { saved = prefs; });
    const box = host.querySelector<HTMLInputElement>("input[aria-label='회사 메일']");
    expect(box?.checked).toBe(true);
    await act(async () => { box!.click(); });
    const raw = storage.getItem(`${CONNECTOR_STORAGE_PREFIX}7`);
    expect(JSON.parse(raw || "{}")).toMatchObject({ "ubion-mail": { enabled: false } });
    expect(saved?.["ubion-mail"]?.enabled).toBe(false);
    await act(async () => { root.unmount(); });
  });
});
