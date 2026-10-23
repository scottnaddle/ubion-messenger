import { describe, expect, it } from "vitest";
import { intersectRect, placeFloating } from "../src/lib/floating";
const pane = { left: 300, top: 50, right: 1000, bottom: 800 };
describe("placeFloating", () => {
  it("opens above by default", () => {
    expect(placeFloating({ left: 500, top: 400, right: 526, bottom: 422 }, { width: 300, height: 40 }, pane))
      .toEqual({ left: 500, top: 356, placement: "top" });
  });
  it("flips below when no room above", () => {
    expect(placeFloating({ left: 500, top: 60, right: 526, bottom: 82 }, { width: 300, height: 40 }, pane).placement).toBe("bottom");
  });
  it("shifts right so it never covers the left room list", () => {
    expect(placeFloating({ left: 200, top: 400, right: 226, bottom: 422 }, { width: 336, height: 300 }, pane).left).toBe(306);
    expect(placeFloating({ left: 980, top: 400, right: 1000, bottom: 422 }, { width: 336, height: 40 }, pane).left).toBe(658);
  });
  it("falls back to the viewport for a degenerate pane", () => {
    expect(intersectRect({ left: 0, top: 0, right: 10, bottom: 10 }, pane)).toEqual(pane);
  });
});
