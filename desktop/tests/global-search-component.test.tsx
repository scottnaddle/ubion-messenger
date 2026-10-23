// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GlobalSearch } from "../src/components/GlobalSearch";
import type { Room } from "../src/api";
import type { GlobalSearchProgress, GlobalSearchResult } from "../src/lib/global-search";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let progressCb: ((p: GlobalSearchProgress) => void) | null;
let resolveSearch: (r: GlobalSearchResult) => void;
const globalSearch = vi.fn();

const room = (key: string, name: string) => ({ key, name } as unknown as Room);

beforeEach(() => {
  progressCb = null;
  globalSearch.mockReset().mockImplementation(() => new Promise((r) => (resolveSearch = r)));
  (window as any).ubion = {
    platform: "linux",
    call: () => new Promise(() => undefined),
    search: {
      caps: async () => ({ server: true, dateRange: false, maxRooms: 60, localEngine: "inverted-index-json" }),
      global: globalSearch,
      cancel: vi.fn(async () => undefined),
      onProgress: (cb: (p: GlobalSearchProgress) => void) => ((progressCb = cb), () => undefined),
    },
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("GlobalSearch modal", () => {
  it("shows filter chips, streams partial results grouped by room, and jumps to the room on click", async () => {
    const onOpenRoom = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(<GlobalSearch rooms={[room("room:1", "알파 TF"), room("buddy:2", "김하늘")]} initialKeyword="예산" onOpenRoom={onOpenRoom} onClose={onClose} />);
    });
    const text = () => document.body.textContent || "";
    expect(text()).toContain("사람");
    expect(text()).toContain("기간");
    expect(text()).toContain("파일");
    expect(globalSearch).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ keyword: "예산" }));
    const id = globalSearch.mock.calls[0][0];
    await act(async () => {
      progressCb!({ searchId: id, phase: "server", searchedRooms: 1, totalRooms: 2, hits: [
        { roomKey: "room:1", messageId: 1, sendUserName: "이", message: "예산 초안", createdAt: "2026-10-01T00:00:00Z", source: "local" },
      ] });
      progressCb!({ searchId: id + 99, phase: "server", searchedRooms: 1, totalRooms: 2, hits: [
        { roomKey: "room:1", messageId: 9, sendUserName: "x", message: "stale search", source: "server" },
      ] });
    });
    expect(text()).toContain("예산 초안");
    expect(text()).not.toContain("stale search");
    expect(text()).toContain("1/2");
    await act(async () => {
      resolveSearch({ searchId: id, searchedRooms: 2, totalRooms: 2, failedRooms: 0, cancelled: false, serverSearched: true, hits: [
        { roomKey: "buddy:2", messageId: 2, sendUserName: "김", message: "예산 최종", createdAt: "2026-10-02T00:00:00Z", source: "server" },
        { roomKey: "room:1", messageId: 1, sendUserName: "이", message: "예산 초안", createdAt: "2026-10-01T00:00:00Z", source: "server" },
      ] });
    });
    const rooms = [...document.querySelectorAll(".gsearch-room")].map((e) => e.textContent);
    expect(rooms).toEqual(["김하늘 1", "알파 TF 1"]);
    const hit = [...document.querySelectorAll<HTMLButtonElement>(".gsearch-hit")].find((b) => b.textContent?.includes("예산 최종"))!;
    act(() => hit.click());
    expect(onOpenRoom).toHaveBeenCalledWith("buddy:2");
    expect(onClose).toHaveBeenCalled();
  });

  it("toggles the file chip into the query", async () => {
    await act(async () => {
      root.render(<GlobalSearch rooms={[]} onOpenRoom={() => undefined} onClose={() => undefined} />);
    });
    const fileChip = [...document.querySelectorAll<HTMLButtonElement>(".chip")].find((b) => b.textContent === "파일")!;
    act(() => fileChip.click());
    const form = document.querySelector<HTMLFormElement>(".gsearch-modal form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(globalSearch).toHaveBeenCalledWith(expect.any(Number), { keyword: undefined, from: undefined, to: undefined, senderSeq: undefined, files: "file" });
  });
});
