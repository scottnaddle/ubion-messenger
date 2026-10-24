// @vitest-environment jsdom
import React from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { FileCard } from "../src/components/FileCard";
import type { ChatMessage } from "../src/api";
import { claimPlaybackError, resetPlaybackErrors } from "../src/lib/playback-error";

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

async function render(message: ChatMessage, toast: (text: string) => void = () => undefined) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<FileCard m={message} mine={false} onOpenMedia={() => undefined} toast={toast} />);
  });
  return { host, root };
}

beforeEach(() => {
  resetPlaybackErrors();
  document.body.innerHTML = "";
});

describe("inline video", () => {
  it("plays mp4 in the bubble and still offers save", async () => {
    const { host, root } = await render(video);
    const el = host.querySelector("video.inline-video");
    expect(el).not.toBeNull();
    expect(el?.getAttribute("controls")).not.toBeNull();
    expect(el?.getAttribute("src")).toContain("messageId=1051");
    expect(el?.getAttribute("src")).toContain("ubmExt=mp4");
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

  it("toasts a playback failure once and leaves an inline fallback", async () => {
    expect(claimPlaybackError("v:1051")).toBe(true);
    expect(claimPlaybackError("v:1051")).toBe(false);
    resetPlaybackErrors();

    const notices: string[] = [];
    const { host, root } = await render(video, (text) => notices.push(text));
    const el = host.querySelector("video.inline-video");
    await act(async () => {
      el?.dispatchEvent(new Event("error"));
      el?.dispatchEvent(new Event("error"));
      el?.dispatchEvent(new Event("error"));
    });
    expect(notices).toEqual(["앱 안에서 재생할 수 없는 형식입니다. '기본 앱으로 열기'를 사용하세요."]);
    expect(host.querySelector("video")).toBeNull();
    expect(host.querySelector(".video-fallback")?.textContent).toContain("기본 앱으로 열기");
    await act(async () => { root.unmount(); });

    const { host: again, root: root2 } = await render(video, (text) => notices.push(text));
    await act(async () => { again.querySelector("video.inline-video")?.dispatchEvent(new Event("error")); });
    expect(notices).toHaveLength(1);
    expect(again.querySelector(".video-fallback")).not.toBeNull();
    await act(async () => { root2.unmount(); });
  });
});
