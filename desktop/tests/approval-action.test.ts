import { describe, expect, it, vi } from "vitest";
import { PortalService, normalizeApprovalActionArgs, parseApprovalActionResult, APPROVAL_ACTION_PATHS } from "../electron/core/portal";

describe("approval actions (mocked fetcher — never hits the real server)", () => {
  it("validates args; 반려 requires a comment", () => {
    expect(normalizeApprovalActionArgs("approve", 11)).toEqual({ kind: "approve", id: "11", comment: "" });
    expect(() => normalizeApprovalActionArgs("return", 11, "  ")).toThrow("반려 사유");
    expect(() => normalizeApprovalActionArgs("delete", 11)).toThrow();
    expect(() => normalizeApprovalActionArgs("approve", "../x")).toThrow();
    expect(() => normalizeApprovalActionArgs("approve", 1, "x".repeat(1001))).toThrow();
  });
  it("builds whitelisted paths", () => {
    expect(APPROVAL_ACTION_PATHS.approve("11")).toBe("/api/approval/document/11/approve");
    expect(APPROVAL_ACTION_PATHS.return("11")).toBe("/api/approval/document/11/return");
  });
  it("parses results", () => {
    expect(parseApprovalActionResult(200, '{"code":"200","message":"OK"}')).toEqual({ ok: true });
    expect(parseApprovalActionResult(200, "")).toEqual({ ok: true });
    expect(() => parseApprovalActionResult(200, '{"code":"400","message":"이미 처리된 문서"}')).toThrow("이미 처리된 문서");
    expect(() => parseApprovalActionResult(403, "<html>")).toThrow("HTTP 403");
  });
  it("sends PUT with comment JSON via fetcher", async () => {
    const fetcher = vi.fn(async () => ({ status: 200, text: '{"code":"200"}' }));
    const svc = new PortalService(fetcher as any, () => undefined);
    await expect(svc.approvalAction("return", 42, " 금액 확인 필요 ")).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith("/api/approval/document/42/return", { method: "PUT", json: { comment: "금액 확인 필요" } });
    await expect(svc.approvalAction("return", 42, "")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
