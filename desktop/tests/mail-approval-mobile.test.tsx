// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Mail } from "../src/components/Mail";
import { Approval } from "../src/components/Approval";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let approvalDoc: ReturnType<typeof vi.fn>;

const folder = (id: number, name: string, fullName: string) => ({
  id: String(id), name, fullName, encName: fullName, depth: 0, newCnt: 0, unseenCnt: 1, totalCnt: 1,
});

const mailItem = {
  uid: 1, folder: "Inbox", subject: "주간 회의", from: { name: "박", address: "park@example.com" },
  preview: "안녕하세요", dateUtc: "2026-10-23T09:00:00+09:00", seen: false,
  hasAttach: false, flagged: false, answered: false, important: false, size: "",
};

const approvalItem = {
  id: 501, documentId: 501, formName: "지출결의서", title: "정산", docStatus: "INPROGRESS",
  docStatusName: "진행중", apprStatusName: "결재대기", attachCount: 0, commentCount: 0,
  drafterName: "김", drafterDeptName: "재무", drafterPositionName: "과장",
  draftedAt: "2026-10-22T09:00:00+09:00", emergency: false, currentActivityUsers: [], url: "/app/approval/document/501",
};

const approvalDetail = (id: number) => ({
  document: {
    id, formName: "지출결의서", title: "정산", docStatusName: "진행중", bodyHtml: "<p>본문</p>",
    attaches: [], drafterName: "김", drafterDeptName: "재무", drafterPositionName: "과장",
  },
  apprFlow: {
    activityGroups: [{
      name: "결재선",
      activities: [{
        type: "APPROVAL", name: "승인", userName: "유인식", userPosition: "팀장", deptName: "재무",
        status: "WAIT", statusName: "대기", comment: "", userId: 312, thumbnail: "/profile/312.png",
      }],
    }],
  },
  actionCheck: {},
  comments: [],
});

function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((q: string) => ({
    matches, media: q, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  })) as any;
}

async function flush(n = 5) {
  await act(async () => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  });
}

async function render(el: React.ReactElement) {
  await act(async () => root.render(el));
  await flush();
}

beforeEach(() => {
  document.documentElement.classList.add("ubm-mobile");
  stubMatchMedia(true);
  approvalDoc = vi.fn(async (id: number) => approvalDetail(id));
  (window as any).ubion = {
    platform: "ios",
    call: vi.fn(async (ch: string) => {
      if (ch === "auth:state") return { user: { id: 1 } };
      if (ch === "org:users") return [{ userId: 1, email: "me@example.com" }];
      return undefined;
    }),
    portal: {
      open: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
      mailFolders: vi.fn(async () => ({
        quota: { usageUnit: "1 GB", limitUnit: "10 GB", percent: 10 },
        defaultFolders: [folder(1, "받은편지함", "Inbox")],
        userFolders: [], userSharedFolders: [], userTags: [],
      })),
      mailList: vi.fn(async () => ({
        folder: "Inbox", folderName: "받은편지함", items: [mailItem],
        page: 1, pageSize: 30, total: 1, unread: 1, lastPage: true, search: false,
      })),
      mailRead: vi.fn(async () => ({
        ...mailItem, to: [], cc: [], html: "<p>본문</p>", attachments: [],
      })),
      mailCaps: vi.fn(async () => ({ delete: false })),
      approvalCounts: vi.fn(async () => ({ todo: 1, upcoming: 0 })),
      approvalList: vi.fn(async (box: string) => ({
        items: box === "todo" ? [approvalItem] : [],
        page: { page: 0, offset: 20, total: box === "todo" ? 1 : 0, totalPage: box === "todo" ? 1 : 0, lastPage: true },
      })),
      approvalDoc,
    },
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.documentElement.classList.remove("ubm-mobile");
});

describe("phone stack navigation", () => {
  it("mail starts on folders, advances to the list and then the reading pane", async () => {
    await render(<Mail />);
    const mail = () => container.querySelector(".mail3")!;
    expect(mail().className).toContain("mail-stack-folders");

    const inbox = [...container.querySelectorAll<HTMLButtonElement>(".mail-folder")]
      .find((b) => b.textContent?.includes("받은편지함"))!;
    await act(async () => inbox.click());
    await flush();
    expect(mail().className).toContain("mail-stack-list");

    const item = container.querySelector<HTMLDivElement>(".mail-item")!;
    await act(async () => item.click());
    await flush();
    expect(mail().className).toContain("mail-stack-read");
    expect(container.textContent).toContain("주간 회의");
  });

  it("approval stays on the box list and only opens the detail after a tap", async () => {
    await render(<Approval />);
    const approval = () => container.querySelector(".approval")!;
    expect(approval().className).toContain("approval-stack-boxes");
    expect(approvalDoc).not.toHaveBeenCalled();

    const todo = [...container.querySelectorAll<HTMLButtonElement>(".approval-box")]
      .find((b) => b.textContent?.includes("결재 대기"))!;
    await act(async () => todo.click());
    await flush();
    expect(approval().className).toContain("approval-stack-list");
    expect(approvalDoc).not.toHaveBeenCalled();

    const item = container.querySelector<HTMLButtonElement>(".approval-item")!;
    await act(async () => item.click());
    await flush();
    expect(approval().className).toContain("approval-stack-detail");
    expect(approvalDoc).toHaveBeenCalledWith(501);
  });
});
