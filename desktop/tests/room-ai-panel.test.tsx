// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RoomAiService, ROOM_AI_LIVE_ERROR, type RoomAiProvider, type StorageLike } from "../src/lib/room-ai";
import { RoomAiPanel } from "../src/components/RoomAiPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function memory(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
  };
}

const messages = [
  { messageId: 1, sendUserName: "김민수", message: "자료 검토 부탁합니다" },
  { messageId: 2, sendUserName: "이서연", message: "내일까지 회신해주세요" },
];

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("Room AI panel", () => {
  it("shows a stub summary and local todos without posting into the chat", async () => {
    let release!: () => void;
    let gate = new Promise<void>((resolve) => { release = resolve; });
    const summarize = vi.fn(async (rows: { text: string }[]) => {
      await gate;
      return `[스텁] ${rows.length}건 요약`;
    });
    const extractTodos = vi.fn(async () => [{ title: "자료 검토하기", assignee: "김민수", sourceMessageIds: [1] }]);
    const jump = vi.fn();
    const service = new RoomAiService({ summarize, extractTodos });
    const storage = memory();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <RoomAiPanel roomKey="room:9" userId={7} messages={messages} focused historyLoading={false} service={service} storage={storage} pollMs={60_000} onJump={jump} />,
      );
    });
    await flush();
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("생각 중");
    expect(host.querySelector(".bubble")).toBeNull();
    await act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain("[스텁] 2건 요약");
    expect(host.textContent).toContain("자료 검토하기");
    expect(host.textContent).toContain("담당 김민수");
    expect(host.textContent).toContain("이 기기에만 저장됩니다");
    expect(host.textContent).toContain("내 봇과 대화");

    const row = host.querySelector<HTMLButtonElement>(".room-ai-todo-jump");
    await act(async () => { row!.click(); });
    expect(jump).toHaveBeenCalledTimes(1);
    expect(jump.mock.calls[0][0].sourceMessageIds).toEqual([1]);
    expect(host.querySelector(".room-ai-todos li.done")).toBeNull();
    expect(host.querySelector(".room-ai-todos li.on")).not.toBeNull();

    const box = host.querySelector<HTMLInputElement>("input[type='checkbox']");
    expect(box?.checked).toBe(false);
    await act(async () => { box!.click(); });
    expect(jump).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".room-ai-todos li.done")).not.toBeNull();

    gate = Promise.resolve();
    const refresh = [...host.querySelectorAll("button")].find((b) => b.textContent === "새로고침");
    await act(async () => { refresh!.click(); });
    await flush();
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".room-ai-todos li.done")).not.toBeNull();
    await act(async () => { root.unmount(); });
    host.remove();
  });

  it("does not call the provider while the window is unfocused or hidden", async () => {
    const summarize = vi.fn(async () => "요약");
    const extractTodos = vi.fn(async () => []);
    const service = new RoomAiService({ summarize, extractTodos });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <RoomAiPanel roomKey="room:9" userId={7} messages={messages} focused={false} historyLoading={false} service={service} storage={memory()} pollMs={60_000} />,
      );
    });
    await flush();
    expect(summarize).not.toHaveBeenCalled();
    expect(host.textContent).toContain("앱이 앞에 있을 때만 갱신합니다");

    const hidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden")
      ?? Object.getOwnPropertyDescriptor(document, "hidden");
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => {
      root.render(
        <RoomAiPanel roomKey="room:9" userId={7} messages={messages} focused historyLoading={false} service={service} storage={memory()} pollMs={60_000} />,
      );
    });
    await flush();
    expect(summarize).not.toHaveBeenCalled();
    if (hidden) Object.defineProperty(document, "hidden", hidden);
    else delete (document as { hidden?: boolean }).hidden;
    await act(async () => { root.unmount(); });
    host.remove();
  });

  it("shows the live proxy error instead of a stub summary", async () => {
    const provider: RoomAiProvider = {
      summarize: async () => { throw new Error(ROOM_AI_LIVE_ERROR); },
      extractTodos: async () => [],
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <RoomAiPanel
          roomKey="room:9" userId={7} messages={messages} focused historyLoading={false}
          service={new RoomAiService(provider)} storage={memory()} pollMs={60_000}
        />,
      );
    });
    await flush();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain(ROOM_AI_LIVE_ERROR);
    expect(host.textContent).not.toContain("[스텁]");
    await act(async () => { root.unmount(); });
    host.remove();
  });
});
