// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { groupFaces } from "../src/lib/group-avatar";
import { RoomAvatar } from "../src/components/ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("groupFaces", () => {
  it("prefers photos, then fills with initials, and caps at four", () => {
    const faces = groupFaces([
      { userId: 1, name: "가", image: "" },
      { userId: 2, name: "나", image: " /a.png " },
      { userId: 2, name: "나 중복", image: "/dup.png" },
      { userId: 3, name: "다", image: "/b.png" },
      { userId: 4, name: "라" },
      { userId: 5, name: "마", image: "/c.png" },
      { userId: 6, name: "바", image: "/d.png" },
      { name: "", image: "" },
      null as unknown as { name: string },
    ]);
    expect(faces.map((f) => f.name)).toEqual(["나", "다", "마", "바"]);
    expect(faces.every((f) => f.src.startsWith("/"))).toBe(true);
  });

  it("keeps a short room and falls back to initials when urls are missing", () => {
    expect(groupFaces([{ userId: 1, name: "가", image: "/a.png" }, { userId: 2, name: "나" }])).toEqual([
      { key: "id:1", name: "가", src: "/a.png" },
      { key: "id:2", name: "나", src: "" },
    ]);
    expect(groupFaces([])).toEqual([]);
    expect(groupFaces(undefined)).toEqual([]);
    expect(groupFaces([{ name: "이름만" }], 1)).toEqual([{ key: "name:이름만", name: "이름만", src: "" }]);
  });
});

describe("RoomAvatar", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
  });

  async function render(node: React.ReactElement) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(node); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }

  it("does not change a 1:1 avatar or ask for members", async () => {
    const call = vi.fn();
    (window as unknown as { ubion: unknown }).ubion = { call };
    await render(<RoomAvatar room={{ key: "buddy:2", kind: "buddy", name: "김하늘", avatar: "/dm.png" }} size={40} />);
    const img = container.querySelector(".avatar img") as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("/dm.png");
    expect(container.querySelector(".avatar-collage")).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it("collages group member photos and uses initials when a url is missing", async () => {
    const call = vi.fn(async (ch: string) => {
      if (ch !== "rooms:members") return [];
      return [
        { userId: 1, name: "가", image: "" },
        { userId: 2, name: "나", image: "/a.png" },
        { userId: 3, name: "다", image: "/b.png" },
      ];
    });
    (window as unknown as { ubion: unknown }).ubion = { call };
    await render(<RoomAvatar room={{ key: "room:collage-1", kind: "room", name: "프로젝트", avatar: "/generic.png" }} size={40} />);
    const collage = container.querySelector(".avatar-collage");
    expect(collage?.className).toContain("n3");
    const imgs = [...container.querySelectorAll(".avatar-collage img")].map((img) => img.getAttribute("src"));
    expect(imgs).toEqual([expect.stringContaining("/a.png"), expect.stringContaining("/b.png")]);
    expect(collage?.textContent).toContain("가");
    expect(container.querySelector(".avatar img")).toBeNull();
  });

  it("keeps the room image when the members API returns nobody", async () => {
    (window as unknown as { ubion: unknown }).ubion = { call: async () => [] };
    await render(<RoomAvatar room={{ key: "room:empty-faces", kind: "room", name: "빈방", avatar: "/generic.png" }} />);
    const img = container.querySelector(".avatar img") as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("/generic.png");
    expect(container.querySelector(".avatar-collage")).toBeNull();
  });
});
