import { describe, expect, it } from "vitest";
import {
  isAllowedPortalPath, normalizeApprovalDocId, normalizeApprovalListArgs,
  parseApprovalDoc, parseApprovalList, parseMailFolders,
} from "../electron/core/portal";
import { isAllowedAttr, isBlockedTag, isSafeStyle, isSafeUrl } from "../src/lib/sanitize";

describe("mail folders", () => {
  it("maps quota and native folder metadata", () => {
    const r = parseMailFolders({
      data: {
        quotaInfo: { usageUnit: "1.2 GB", limitUnit: "10 GB", percent: "12.5" },
        defaultFolders: [
          { id: 1, name: "받은편지함", fullName: "Inbox", encName: "Inbox%2F", depth: 0, newCnt: 2, unseenCnt: 3, totalCnt: 120 },
        ],
        userFolders: [
          { id: 2, name: "업무", fullName: "Inbox/업무", encName: "Inbox%2F%EC%97%85%EB%AC%B4", depth: 1, unseenCnt: "1", totalCnt: "7" },
        ],
        userSharedFolderList: [
          { id: 3, name: "공유", fullName: "Shared", encName: "Shared", depth: 0, totalCnt: 4 },
        ],
        userTags: [{ name: "중요" }, "업무"],
      },
    });
    expect(r.quota).toEqual({ usageUnit: "1.2 GB", limitUnit: "10 GB", percent: 12.5 });
    expect(r.defaultFolders[0]).toMatchObject({ id: "1", name: "받은편지함", encName: "Inbox%2F", unseenCnt: 3, totalCnt: 120 });
    expect(r.userFolders[0]).toMatchObject({ id: "2", depth: 1, unseenCnt: 1, totalCnt: 7 });
    expect(r.userSharedFolders[0].name).toBe("공유");
    expect(r.userTags).toEqual(["중요", "업무"]);
  });

  it("tolerates garbage", () => {
    expect(parseMailFolders(null)).toEqual({
      quota: { usageUnit: "", limitUnit: "", percent: 0 },
      defaultFolders: [], userFolders: [], userSharedFolders: [], userTags: [],
    });
  });
});

describe("approval lists", () => {
  const body = {
    data: [{
      id: 501, documentId: 601, formName: "지출결의서", title: "정산", docStatus: "INPROGRESS",
      docStatusName: "진행중", apprStatusName: "결재대기", attachCount: 2, commentCount: 1,
      drafterName: "김", drafterDeptName: "재무", drafterPositionName: "과장",
      draftedAt: "2026-10-22T09:00:00+09:00", isEmergency: true,
      currentActivityUsers: [{ userName: "이" }, "박"],
    }],
    page: { page: 1, offset: 20, total: 45, totalPage: 3, lastPage: false },
  };

  it("maps list fields, markers and paging", () => {
    const r = parseApprovalList(body);
    expect(r.items[0]).toMatchObject({
      id: 501, documentId: 601, formName: "지출결의서", title: "정산", docStatusName: "진행중",
      apprStatusName: "결재대기", attachCount: 2, commentCount: 1, emergency: true,
      drafterName: "김", drafterDeptName: "재무", currentActivityUsers: ["이", "박"],
      url: "/app/approval/document/501",
    });
    expect(r.page).toEqual({ page: 1, offset: 20, total: 45, totalPage: 3, lastPage: false });
  });

  it("derives page metadata when the server omits it", () => {
    const r = parseApprovalList({ data: [{ id: 1, title: "A" }], page: { total: 41 } });
    expect(r.page).toMatchObject({ page: 0, offset: 20, total: 41, totalPage: 3, lastPage: false });
    expect(parseApprovalList(null)).toEqual({ items: [], page: { page: 0, offset: 20, total: 0, totalPage: 0, lastPage: true } });
  });
});

describe("approval detail", () => {
  it("maps document, approval flow, action checks and defensive comments", () => {
    const body = {
      data: {
        document: {
          id: 601, formName: "지출결의서", title: "정산", docStatusName: "진행중",
          docBodyContent: "<table><tr><td>내용</td></tr></table>",
          attaches: [{ id: 9, name: "영수증.pdf", extention: "pdf", size: 2048, download: "/x" }],
          drafterName: "김", drafterDeptName: "재무", drafterPosionName: "과장", draftedAt: "2026-10-22T09:00:00+09:00",
        },
        apprFlow: { activityGroups: [{ name: "결재선", activities: [{
          type: "approval", name: "승인", userName: "이", userPosition: "팀장", deptName: "재무",
          status: "APPROVED", statusName: "승인", comment: "확인", completedAt: "2026-10-22T10:00:00+09:00",
        }] }] },
        actionCheck: { isApprovalWaitingUser: 1, isAgreementWaitingUser: false },
      },
    };
    const comments = { data: [
      { commentId: 3, userName: "박", content: "확인했습니다", createdAt: "2026-10-22T11:00:00+09:00" },
      { id: 4, writer: { name: "최" }, comment: "감사합니다" },
    ] };
    const r = parseApprovalDoc(body, comments);
    expect(r.document).toMatchObject({
      id: 601, formName: "지출결의서", title: "정산", docStatusName: "진행중",
      bodyHtml: "<table><tr><td>내용</td></tr></table>", drafterPositionName: "과장",
    });
    expect(r.document.attaches[0]).toMatchObject({ id: "9", name: "영수증.pdf", size: 2048 });
    expect(r.apprFlow.activityGroups[0].activities[0]).toMatchObject({ userName: "이", statusName: "승인", comment: "확인" });
    expect(r.actionCheck).toEqual({ isApprovalWaitingUser: true, isAgreementWaitingUser: false });
    expect(r.comments).toEqual([
      { id: "3", author: "박", content: "확인했습니다", createdAt: "2026-10-22T11:00:00+09:00" },
      { id: "4", author: "최", content: "감사합니다", createdAt: undefined },
    ]);
  });

  it("tolerates garbage", () => {
    expect(parseApprovalDoc(null).document.attaches).toEqual([]);
    expect(parseApprovalDoc({ data: { apprFlow: { activityGroups: "x" } } }, null).comments).toEqual([]);
  });
});

describe("portal whitelist + argument validation", () => {
  it("allows only the new GET-only mail/approval paths", () => {
    expect(isAllowedPortalPath("/api/mail/folder/all")).toBe(true);
    expect(isAllowedPortalPath("/api/approval/todo/all")).toBe(true);
    expect(isAllowedPortalPath("/api/approval/upcoming?page=0&offset=20")).toBe(true);
    expect(isAllowedPortalPath("/api/approval/doclist/draft/all?page=2")).toBe(true);
    expect(isAllowedPortalPath("/api/approval/doclist/approve/all")).toBe(true);
    expect(isAllowedPortalPath("/api/approval/upcoming/count")).toBe(true);
    expect(isAllowedPortalPath("/api/approval/todoreception/count")).toBe(true);
    expect(isAllowedPortalPath("/api/approval/document/123")).toBe(true);
    expect(isAllowedPortalPath("/api/approval/document/123/comment")).toBe(true);
  });

  it("rejects write/unknown approval and mail endpoints", () => {
    expect(isAllowedPortalPath("/api/mail/message/list")).toBe(false);
    expect(isAllowedPortalPath("/api/approval/document/1/approve")).toBe(false);
    expect(isAllowedPortalPath("/api/approval/document/1/download/2")).toBe(false);
    expect(isAllowedPortalPath("/api/approval/doclist/draft/all/extra")).toBe(false);
    expect(isAllowedPortalPath("/api/approval/document/abc")).toBe(false);
  });

  it("validates approval list args", () => {
    expect(normalizeApprovalListArgs("todo", 0, "")).toEqual({ box: "todo", page: 0, keyword: "" });
    expect(normalizeApprovalListArgs("approve", "2", "회의")).toEqual({ box: "approve", page: 2, keyword: "회의" });
    expect(() => normalizeApprovalListArgs("inbox", 0, "")).toThrow(/box/);
    expect(() => normalizeApprovalListArgs("todo", -1, "")).toThrow(/page/);
    expect(() => normalizeApprovalListArgs("todo", 10001, "")).toThrow(/page/);
    expect(() => normalizeApprovalListArgs("todo", 1.5, "")).toThrow(/page/);
    expect(() => normalizeApprovalListArgs("todo", 0, "x".repeat(101))).toThrow(/keyword/);
    expect(normalizeApprovalListArgs("todo", 0, "x".repeat(100)).keyword).toHaveLength(100);
  });

  it("validates document ids", () => {
    expect(normalizeApprovalDocId(123)).toBe("123");
    expect(normalizeApprovalDocId(" 456 ")).toBe("456");
    expect(() => normalizeApprovalDocId("12/../approve")).toThrow(/id/);
    expect(() => normalizeApprovalDocId("abc")).toThrow(/id/);
    expect(() => normalizeApprovalDocId(1.5)).toThrow(/id/);
  });
});

describe("sanitize helpers (DOM-free pieces)", () => {
  it("blocks dangerous tags and event attributes", () => {
    expect(isBlockedTag("SCRIPT")).toBe(true);
    expect(isBlockedTag("iframe")).toBe(true);
    expect(isBlockedTag("form")).toBe(true);
    expect(isBlockedTag("table")).toBe(false);
    expect(isAllowedAttr("onclick")).toBe(false);
    expect(isAllowedAttr("ONERROR")).toBe(false);
    expect(isAllowedAttr("style")).toBe(true);
    expect(isAllowedAttr("href")).toBe(true);
  });

  it("allows safe urls and data:image only", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("java\nscript:alert(1)")).toBe(false);
    expect(isSafeUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeUrl("data:text/html,<script>x</script>")).toBe(false);
    expect(isSafeUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isSafeUrl("https://coco.ubion.co.kr/app/mail")).toBe(true);
    expect(isSafeUrl("/app/approval/document/1")).toBe(true);
  });

  it("keeps harmless inline styles only", () => {
    expect(isSafeStyle("color:red;font-weight:bold")).toBe(true);
    expect(isSafeStyle("background-image:url(data:image/png;base64,AAAA)")).toBe(true);
    expect(isSafeStyle("background:url(javascript:alert(1))")).toBe(false);
    expect(isSafeStyle("width:expression(alert(1))")).toBe(false);
  });
});
