// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeApprovalHtml } from "../src/lib/sanitize";

describe("approval body sanitizing", () => {
  it("keeps the existing allowlist and strips dangerous markup", () => {
    const r = sanitizeApprovalHtml(
      '<p onclick="x()">본문</p><script>alert(1)</script><iframe src="https://e.example"></iframe>' +
        '<a href="javascript:alert(1)">j</a><form><input></form><style>body{}</style>',
    );
    expect(r).toContain("본문");
    expect(r).not.toMatch(/script|onclick|iframe|<form|<input|<style|javascript:/i);
  });

  it("removes fixed table/cell widths and nowrap so the form can reflow", () => {
    const r = sanitizeApprovalHtml(
      '<table width="800" style="width:800px;color:red"><tr>' +
        '<td width="120" style="width:120px;white-space:nowrap;min-width:300px">아주 긴 항목 이름</td>' +
        '<td style="width:50%;min-width:100px">값</td>' +
        "</tr></table>",
    );
    expect(r).not.toContain('width="800"');
    expect(r).not.toContain('width="120"');
    expect(r).not.toMatch(/800px|120px/);
    expect(r).not.toMatch(/nowrap/i);
    expect(r).not.toMatch(/min-width/i);
    expect(r).toMatch(/color:\s*red/i);
    expect(r).toMatch(/width:\s*50%/i);
    expect(r).toContain("아주 긴 항목 이름");
  });

  it("keeps relative table widths and image size hints", () => {
    const table = sanitizeApprovalHtml('<table width="100%"><tr><td>내용</td></tr></table>');
    expect(table).toContain('width="100%"');

    const img = sanitizeApprovalHtml(
      '<img src="https://example.com/stamp.png" width="120" height="80" style="width:900px;min-width:1000px">',
    );
    expect(img).toContain('width="120"');
    expect(img).toContain('height="80"');
    expect(img).toMatch(/width:\s*900px/i);
    expect(img).not.toMatch(/min-width/i);
  });

  it("returns an empty string for empty input", () => {
    expect(sanitizeApprovalHtml("")).toBe("");
  });
});
