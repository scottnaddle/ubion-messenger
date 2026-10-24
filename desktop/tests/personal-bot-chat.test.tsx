// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { PersonalBotChat } from "../src/components/PersonalBotChat";
import {
  PERSONAL_BOT_GREETING,
  PERSONAL_BOT_LIVE_ERROR,
  type PersonalBotClient,
  type PersonalBotStorage,
} from "../src/lib/personal-bot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function memory(): PersonalBotStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
  };
}

function setTextarea(el: HTMLTextAreaElement, value: string) {
  const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
  proto?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function renderChat(client: PersonalBotClient, storage = memory()) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<PersonalBotChat userId={7} client={client} storage={storage} />);
  });
  return { host, root };
}

describe("PersonalBotChat", () => {
  it("uses room chat chrome and shows a live reply without stub framing", async () => {
    let release!: (text: string) => void;
    const reply = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const client: PersonalBotClient = { mode: "live", reply };
    const { host, root } = await renderChat(client);
    expect(host.querySelector(".chat-head")).not.toBeNull();
    expect(host.querySelector(".msg-list .bubble")).not.toBeNull();
    expect(host.querySelector(".composer textarea")).not.toBeNull();
    expect(host.querySelector(".send-btn")).not.toBeNull();
    expect(host.textContent).toContain(PERSONAL_BOT_GREETING);
    expect(host.textContent).not.toContain("스텁 대화");
    const gear = host.querySelector<HTMLButtonElement>("[aria-label='비서 연결']");
    await act(async () => { gear!.click(); });
    expect(host.textContent).toContain("회사 메일");
    expect(host.textContent).toContain("나중에 연결");
    await act(async () => { gear!.click(); });

    const ta = host.querySelector("textarea")!;
    await act(async () => { setTextarea(ta, "오늘 일정 있어?"); });
    const send = host.querySelector<HTMLButtonElement>(".send-btn")!;
    await act(async () => { send.click(); });
    expect(host.textContent).toContain("생각 중");
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).toMatchObject({
      userId: 7,
      messages: [{ role: "user", content: "오늘 일정 있어?" }],
    });

    await act(async () => { release("일정은 아직 연결 전입니다. 원하시는 시간을 말씀해 주세요."); });
    expect(host.textContent).toContain("일정은 아직 연결 전입니다. 원하시는 시간을 말씀해 주세요.");
    expect(host.textContent).not.toContain("[스텁]");
    expect(host.textContent).not.toContain("메모해 두었습니다");
    expect(host.querySelectorAll(".msg.mine").length).toBe(1);
    await act(async () => { root.unmount(); });
  });

  it("shows a Korean error and does not fall back to the stub", async () => {
    const client: PersonalBotClient = {
      mode: "live",
      reply: async () => { throw new Error(PERSONAL_BOT_LIVE_ERROR); },
    };
    const { host, root } = await renderChat(client);
    const ta = host.querySelector("textarea")!;
    await act(async () => { setTextarea(ta, "안녕"); });
    await act(async () => { host.querySelector<HTMLButtonElement>(".send-btn")!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain(PERSONAL_BOT_LIVE_ERROR);
    expect(host.textContent).toContain("안녕");
    expect(host.textContent).not.toContain("[스텁]");
    expect(host.textContent).not.toContain("메모해 두었습니다");
    await act(async () => { root.unmount(); });
  });
});
