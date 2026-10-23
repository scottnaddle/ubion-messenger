import { describe, expect, it } from "vitest";
import { getChoseong, rankPalette, type PaletteItem } from "../src/lib/palette";

describe("getChoseong", () => {
  it("extracts Korean 초성", () => {
    expect(getChoseong("결재")).toBe("ㄱㅈ");
    expect(getChoseong("메일")).toBe("ㅁㅇ");
    expect(getChoseong("김하늘")).toBe("ㄱㅎㄴ");
  });

  it("passes non-Hangul through unchanged", () => {
    expect(getChoseong("ABC")).toBe("ABC");
    expect(getChoseong("flex")).toBe("flex");
  });
});

const item = (id: string, label: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({ id, kind: "screen", label, ...extra });

describe("rankPalette", () => {
  const items = [
    item("a", "결재"),
    item("b", "메일"),
    item("c", "메시지"),
    item("d", "조직도", { sublabel: "사람들" }),
    item("e", "홈"),
  ];

  it("returns the first N items in order for an empty query", () => {
    expect(rankPalette(items, "", 3).map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(rankPalette(items, "  ", 2).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("ranks exact > prefix > substring", () => {
    const list = [item("x", "김하늘"), item("y", "김하늘님"), item("z", "우리김하늘팀"), item("w", "김")];
    expect(rankPalette(list, "김하늘").map((i) => i.id)).toEqual(["x", "y", "z"]);
    expect(rankPalette(list, "김").map((i) => i.id)).toEqual(["w", "x", "y", "z"]);
  });

  it("matches Korean 초성 (ㄱㅈ → 결재)", () => {
    expect(rankPalette(items, "ㄱㅈ").map((i) => i.id)).toEqual(["a"]);
    expect(rankPalette(items, "ㅁㅅㅈ").map((i) => i.id)).toEqual(["c"]);
  });

  it("matches sublabel", () => {
    expect(rankPalette(items, "사람").map((i) => i.id)).toEqual(["d"]);
  });

  it("is case-insensitive for Latin text", () => {
    expect(rankPalette([item("f", "Flex")], "flex").map((i) => i.id)).toEqual(["f"]);
  });

  it("returns no results for an unmatched query", () => {
    expect(rankPalette(items, "없는단어")).toEqual([]);
  });

  it("honors the limit and keeps stable order on ties", () => {
    const many = Array.from({ length: 20 }, (_, i) => item(`m${i}`, "같은이름"));
    expect(rankPalette(many, "같은이름", 5).map((i) => i.id)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });
});
