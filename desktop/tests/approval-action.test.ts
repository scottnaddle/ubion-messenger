import { describe, expect, it, vi } from "vitest";
import {
  PortalService, normalizeApprovalActionArgs, parseApprovalActionResult, APPROVAL_ACTION_PATH,
  extractApprovalActionContext, approvalActionBody,
} from "../electron/core/portal";

const ME = 501;
const detail = (over: any = {}) => ({
  code: "200",
  data: {
    document: { id: 120738, docVersionId: 86797, ...(over.document ?? {}) },
    apprFlow: {
      apprFlowVersionId: 87095,
      activityGroups: [{ name: "결재", activities: over.activities ?? [
        { id: 742009, userId: 400, status: "COMPLETE" },
        { id: 742010, userId: ME, status: "WAIT" },
      ] }],
      ...(over.apprFlow ?? {}),
    },
    actionCheck: { isApprovalWaitingUser: true },
  },
});

describe("approval actions (mocked fetcher — never hits the real server)", () => {
  it("validates args; 반려 requires a comment", () => {
    expect(normalizeApprovalActionArgs("approve", 11)).toEqual({ kind: "approve", id: "11", comment: "" });
    expect(() => normalizeApprovalActionArgs("return", 11, "  ")).toThrow("반려 사유");
    expect(() => normalizeApprovalActionArgs("delete", 11)).toThrow();
    expect(() => normalizeApprovalActionArgs("approve", "../x")).toThrow();
  });
  it("uses the observed path", () => {
    expect(APPROVAL_ACTION_PATH("120738")).toBe("/api/approval/document/120738/approval");
  });
  it("extracts ids; fails closed when missing or ambiguous", () => {
    expect(extractApprovalActionContext(detail(), ME)).toEqual({ activityId: 742010, apprFlowVersionId: 87095, docVersionId: 86797 });
    expect(() => extractApprovalActionContext(detail({ document: { docVersionId: undefined } }), ME)).toThrow("docVersionId");
    expect(() => extractApprovalActionContext(detail({ apprFlow: { apprFlowVersionId: null } }), ME)).toThrow("apprFlowVersionId");
    expect(() => extractApprovalActionContext(detail(), null)).toThrow("activityId");
    expect(() => extractApprovalActionContext(detail({ activities: [{ id: 1, userId: ME, status: "WAIT" }, { id: 2, userId: ME, status: "WAIT" }] }), ME)).toThrow("특정");
  });
  it("builds the observed body", () => {
    const b = approvalActionBody("120738", "approve", { activityId: 742010, apprFlowVersionId: 87095, docVersionId: 86797 }, "");
    expect(b).toEqual({ "120738": {}, activityId: 742010, apprAction: "APPROVAL", apprFlowVersionId: 87095, arbtAddReferrer: false,
      comment: "", docVersionId: 86797, userApprSetting: { useNextApproval: false } });
  });
  it("parses results", () => {
    expect(parseApprovalActionResult(200, '{"code":"200"}')).toEqual({ ok: true });
    expect(() => parseApprovalActionResult(200, '{"code":"400","message":"이미 처리된 문서"}')).toThrow("이미 처리된 문서");
    expect(() => parseApprovalActionResult(403, "<html>")).toThrow("HTTP 403");
  });
  it("GETs detail then PUTs; nothing sent when ids are missing", async () => {
    const calls: any[] = [];
    let body: any = detail();
    const fetcher = vi.fn(async (path: string, init: any) => {
      calls.push([path, init]);
      return init?.method === "PUT" ? { status: 200, text: '{"code":"200"}' } : { status: 200, text: JSON.stringify(body) };
    });
    const svc = new PortalService(fetcher as any, () => undefined);
    svc.getUserId = () => ME;
    await svc.approvalAction("return", 120738, " 금액 확인 ");
    const put = calls.find((c) => c[1]?.method === "PUT");
    expect(put[0]).toBe("/api/approval/document/120738/approval");
    expect(put[1].json).toMatchObject({ apprAction: "RETURN", comment: "금액 확인", activityId: 742010 });
    calls.length = 0;
    body = detail({ document: { docVersionId: undefined } });
    await expect(svc.approvalAction("approve", 120739)).rejects.toThrow("docVersionId");
    expect(calls.some((c) => c[1]?.method === "PUT")).toBe(false);
  });
});
