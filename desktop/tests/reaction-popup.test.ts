import { describe, expect, it } from "vitest";
import { isInsideReactionUi } from "../src/components/Reactions";
describe("isInsideReactionUi", () => {
  it("only an outside node closes the palette", () => {
    const inner = { contains: (n: unknown) => n === "cell" } as unknown as Node;
    const btn = { contains: (n: unknown) => n === "plus" } as unknown as Node;
    expect(isInsideReactionUi("cell" as unknown as Node, inner, btn)).toBe(true);
    expect(isInsideReactionUi("plus" as unknown as Node, inner, btn)).toBe(true);
    expect(isInsideReactionUi("list" as unknown as Node, inner, btn)).toBe(false);
    expect(isInsideReactionUi(null, inner, btn)).toBe(false);
  });
});
