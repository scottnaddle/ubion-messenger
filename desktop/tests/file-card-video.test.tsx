// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { FileCard } from "../src/components/FileCard";
import type { ChatMessage } from "../src/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const video = {
  messageId: 1051,
  sendUserSeq: 2,
  sendUserName: "김하늘",
  message: "",
  messageType: "SENDFILE",
  createdAt: "2026-10-24T01:00:00.000Z",
  attach: { cryptId: "v", name: "시연영상.mp4", size: 1024, extention: "mp4" },
} as ChatMessage;

const pdf = {
  ...video,
  messageId: 1052,
  attach: { cryptId: "p", name: "안내.pdf", size: 1024, extention: "pdf" },
} as ChatMessage;

async function render(message: ChatMessage) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<FileCard m={message} mine={false} onOpenMedia={() => undefined} toast={() => undefined} />);
  });
  return { host, root };
}

describe("inline video", () => {
  it("plays mp4 in the bubble and still offers save", async () => {
    const { host, root } = await render(video);
    const el = host.querySelector("video.inline-video");
    expect(el).not.toBeNull();
    expect(el?.getAttribute("controls")).not.toBeNull();
    expect(el?.getAttribute("src")).toContain("v");
    expect(host.textContent).toContain("저장");
    expect(host.textContent).toContain("다른 이름으로 저장");
    expect(host.textContent).toContain("크게 보기");
    await act(async () => { root.unmount(); });
  });

  it("keeps a non-video attachment as a file card", async () => {
    const { host, root } = await render(pdf);
    expect(host.querySelector("video")).toBeNull();
    expect(host.querySelector(".file-card")).not.toBeNull();
    expect(host.textContent).toContain("안내.pdf");
    await act(async () => { root.unmount(); });
  });
});
