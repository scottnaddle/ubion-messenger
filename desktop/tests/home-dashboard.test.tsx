// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Home } from "../src/components/Home";
import { Mail } from "../src/components/Mail";
import { Approval } from "../src/components/Approval";
import type { ApprovalOpenTarget, MailOpenTarget } from "../src/lib/home-open";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(n = 5) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function clickButton(text: string) {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`missing button: ${text}`);
  btn.click();
}

const portalOpen = vi.fn(async () => undefined);

const snap = {
  summary: { chips: [{ appName: "mail", gadgetName: "오늘 온 메일", count: 2 }, { appName: "approval", gadgetName: "결재할 문서", count: 1 }] },
  badge: { approval: 2, noti: 0, mail: 2 },
  widgets: {
    posts: { id: "posts", data: { total: 1, items: [{ id: 2, boardId: 7, boardName: "공지", summary: "워크숍 안내", url: "/app/board/7/post/2" }] } },
    approvalTodo: { id: "approvalTodo", data: { total: 1, items: [{ id: 501, documentId: 601, formName: "지출결의서", title: "10월 정산", url: "/app/approval/document/501" }] } },
    approvalUpcoming: { id: "approvalUpcoming", data: { total: 1, items: [{ id: 77, formName: "휴가원", title: "다음 주 휴가", url: "/app/approval/document/77" }] } },
    mail: { id: "mail", data: { total: 2, today: 2, items: [
      { id: "101", folderName: "받은편지함", folderFullName: "Inbox", subject: "주간 회의록", from: "김철수", seen: false, url: "/app/mail?work=read&folder=Inbox&uid=101" },
      { id: "bad", folderName: "받은편지함", folderFullName: "Inbox", subject: "깨진 메일", from: "이", seen: true, url: "/app/mail?work=read&folder=Inbox&uid=bad" },
    ] } },
  },
};

beforeEach(() => {
  portalOpen.mockClear();
  (window as unknown as { ubion: unknown }).ubion = {
    portal: {
      get: async () => snap,
      refresh: async () => snap,
      open: portalOpen,
      flexPending: async () => ({ count: 1, at: Date.now() }),
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

describe("Home dashboard rows", () => {
  it("opens mail and approval in-app and leaves other widgets on the portal", async () => {
    const onLocal = vi.fn();
    const onOpenMail = vi.fn();
    const onOpenApproval = vi.fn();
    await act(async () => {
      root.render(<Home onLocal={onLocal} onOpenMail={onOpenMail} onOpenApproval={onOpenApproval} />);
    });
    await flush();

    await act(async () => { clickButton("주간 회의록"); });
    expect(onOpenMail).toHaveBeenCalledWith({ folder: "Inbox", uid: 101, seen: false });
    expect(portalOpen).not.toHaveBeenCalled();

    await act(async () => { clickButton("10월 정산"); });
    expect(onOpenApproval).toHaveBeenCalledWith({ box: "todo", id: 501, documentId: 601 });

    await act(async () => { clickButton("다음 주 휴가"); });
    expect(onOpenApproval).toHaveBeenCalledWith({ box: "upcoming", id: 77 });

    await act(async () => { clickButton("오늘 온 메일"); });
    expect(onLocal).toHaveBeenCalledWith("mail");
    expect(onOpenMail).toHaveBeenCalledTimes(1);

    await act(async () => { clickButton("워크숍 안내"); });
    expect(portalOpen).toHaveBeenCalledWith("/app/board/7/post/2");

    await act(async () => { clickButton("깨진 메일"); });
    expect(portalOpen).toHaveBeenCalledWith("/app/mail?work=read&folder=Inbox&uid=bad");
    expect(onOpenMail).toHaveBeenCalledTimes(1);

    const mailCard = [...document.querySelectorAll(".home-card")].find((el) => el.textContent?.includes("메일 · 오늘 온 메일"));
    const web = mailCard?.querySelector("header button");
    await act(async () => { (web as HTMLButtonElement).click(); });
    expect(portalOpen).toHaveBeenCalledWith("/app/mail?work=quick&folder=today");
  });
});

function mailBridge(mailRead: ReturnType<typeof vi.fn>, mailList: ReturnType<typeof vi.fn>) {
  (window as unknown as { ubion: unknown }).ubion = {
    call: async () => null,
    portal: {
      open: portalOpen,
      refresh: async () => ({}),
      mailCaps: async () => ({ delete: false }),
      mailFolders: async () => ({
        quota: { usageUnit: "", limitUnit: "", percent: 0 },
        defaultFolders: [
          { id: "1", name: "받은편지함", fullName: "Inbox", encName: "Inbox", depth: 0, newCnt: 0, unseenCnt: 1, totalCnt: 2 },
          { id: "2", name: "보낸편지함", fullName: "Sent", encName: "Sent", depth: 0, newCnt: 0, unseenCnt: 0, totalCnt: 1 },
        ],
        userFolders: [],
        userSharedFolders: [],
        userTags: [],
      }),
      mailList,
      mailRead,
    },
  };
}

describe("Mail opened from the dashboard", () => {
  it("reads the targeted message in that folder", async () => {
    const mailRead = vi.fn(async (folder: string, uid: number) => ({
      uid, folder, subject: `subj-${uid}`, from: { name: "김", address: "a@b.c" },
      to: [], cc: [], dateUtc: new Date().toISOString(), html: "<p>본문</p>", important: false, flagged: false, attachments: [],
    }));
    const mailList = vi.fn(async (folder: string, page: number) => ({
      folder, folderName: folder === "Sent" ? "보낸편지함" : folder, page, pageSize: 30, total: 1, unread: 1, lastPage: true, search: false,
      items: [{
        uid: 55, folder, subject: "목록제목", from: { name: "김", address: "a@b.c" }, preview: "미리보기",
        seen: false, hasAttach: false, flagged: false, answered: false, important: false, size: "1KB",
      }],
    }));
    mailBridge(mailRead, mailList);
    const initial: MailOpenTarget = { folder: "Sent", uid: 55, seen: false };
    await act(async () => { root.render(<Mail initial={initial} />); });
    await flush();
    expect(mailList).toHaveBeenCalledWith("Sent", 1, "");
    expect(mailRead).toHaveBeenCalledWith("Sent", 55);
    expect(document.querySelector(".mail-read h3")?.textContent).toContain("subj-55");
    const row = document.querySelector(".mail-item");
    expect(row?.className).toContain("active");
    expect(row?.className).not.toContain("unread");
    expect(document.querySelector(".mail-folder.on")?.textContent).toContain("보낸편지함");
    expect(portalOpen).not.toHaveBeenCalled();
  });

  it("without a target stays on the inbox and does not read a message", async () => {
    const mailRead = vi.fn();
    const mailList = vi.fn(async (folder: string, page: number) => ({
      folder, folderName: "받은편지함", page, pageSize: 30, total: 0, unread: 0, lastPage: true, search: false, items: [],
    }));
    mailBridge(mailRead, mailList);
    await act(async () => { root.render(<Mail />); });
    await flush();
    expect(mailList).toHaveBeenCalledWith("Inbox", 1, "");
    expect(mailRead).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("메일을 선택하면 여기에서 바로 읽을 수 있습니다.");
  });
});

function approvalItem(id: number, title: string, documentId?: number) {
  return {
    id, documentId, formName: "양식", title, attachCount: 0, commentCount: 0,
    drafterName: "홍", drafterDeptName: "개발", drafterPositionName: "",
    emergency: false, currentActivityUsers: [] as string[], url: `/app/approval/document/${documentId ?? id}`,
  };
}

function approvalBridge(
  approvalList: ReturnType<typeof vi.fn>,
  approvalDoc: ReturnType<typeof vi.fn>,
) {
  (window as unknown as { ubion: unknown }).ubion = {
    portal: {
      open: portalOpen,
      approvalCounts: async () => ({ todo: 1, upcoming: 1 }),
      approvalList,
      approvalDoc,
    },
  };
}

function detail(id: number) {
  return {
    document: {
      id, formName: "양식", title: `doc-${id}`, docStatusName: "진행", bodyHtml: "<p>본문</p>",
      attaches: [], drafterName: "홍", drafterDeptName: "개발", drafterPositionName: "", draftedAt: "",
    },
    apprFlow: { activityGroups: [] },
    actionCheck: {},
    comments: [],
  };
}

describe("Approval opened from the dashboard", () => {
  it("opens the document id and box instead of the first row", async () => {
    const approvalDoc = vi.fn(async (id: number | string) => detail(Number(id)));
    const approvalList = vi.fn(async (box: string) => ({
      items: box === "upcoming" ? [approvalItem(1, "첫번째"), approvalItem(22, "타겟", 22)] : [approvalItem(7, "대기첫건")],
      page: { page: 0, offset: 20, total: 2, totalPage: 1, lastPage: true },
    }));
    approvalBridge(approvalList, approvalDoc);
    const initial: ApprovalOpenTarget = { box: "upcoming", id: 22, documentId: 22 };
    await act(async () => { root.render(<Approval initial={initial} />); });
    await flush();
    expect(approvalList).toHaveBeenCalledWith("upcoming", 0, "");
    expect(document.querySelector(".approval-list-head b")?.textContent).toBe("결재 예정");
    expect(document.querySelector(".approval-title h3")?.textContent).toBe("doc-22");
    const ids = approvalDoc.mock.calls.map((c) => Number(c[0]));
    expect(ids).toContain(22);
    expect(ids).not.toContain(1);
    expect(document.querySelector(".approval-item.active")?.textContent).toContain("타겟");
  });

  it("loads documentId when it differs from the list id", async () => {
    const approvalDoc = vi.fn(async (id: number | string) => detail(Number(id)));
    const approvalList = vi.fn(async () => ({
      items: [approvalItem(501, "정산", 601)],
      page: { page: 0, offset: 20, total: 1, totalPage: 1, lastPage: true },
    }));
    approvalBridge(approvalList, approvalDoc);
    await act(async () => { root.render(<Approval initial={{ box: "todo", id: 501, documentId: 601 }} />); });
    await flush();
    expect(approvalDoc).toHaveBeenCalledWith(601);
    expect(document.querySelector(".approval-title h3")?.textContent).toBe("doc-601");
    expect(document.querySelector(".approval-list-head b")?.textContent).toBe("결재 대기");
  });

  it("keeps a document that is not on the first page", async () => {
    const approvalDoc = vi.fn(async (id: number | string) => detail(Number(id)));
    const approvalList = vi.fn(async (box: string) => ({
      items: box === "draft" || box === "approve" ? [] : [approvalItem(1, "첫번째")],
      page: { page: 0, offset: 20, total: 1, totalPage: 1, lastPage: true },
    }));
    approvalBridge(approvalList, approvalDoc);
    await act(async () => { root.render(<Approval initial={{ box: "upcoming", id: 99 }} />); });
    await flush();
    expect(document.querySelector(".approval-title h3")?.textContent).toBe("doc-99");
    expect(approvalDoc.mock.calls.map((c) => Number(c[0]))).not.toContain(1);
  });

  it("does not snap back after the user picks another row", async () => {
    const approvalDoc = vi.fn(async (id: number | string) => detail(Number(id)));
    const approvalList = vi.fn(async (box: string) => ({
      items: box === "upcoming" ? [approvalItem(1, "첫번째"), approvalItem(22, "타겟", 22)] : [],
      page: { page: 0, offset: 20, total: 2, totalPage: 1, lastPage: true },
    }));
    approvalBridge(approvalList, approvalDoc);
    await act(async () => { root.render(<Approval initial={{ box: "upcoming", id: 22, documentId: 22 }} />); });
    await flush();
    expect(document.querySelector(".approval-title h3")?.textContent).toBe("doc-22");
    await act(async () => { clickButton("첫번째"); });
    await flush();
    expect(document.querySelector(".approval-title h3")?.textContent).toBe("doc-1");
    expect(approvalDoc).toHaveBeenCalledWith(1);
  });

  it("without a target still opens the first document in 결재 대기", async () => {
    const approvalDoc = vi.fn(async (id: number | string) => detail(Number(id)));
    const approvalList = vi.fn(async (box: string) => ({
      items: box === "todo" ? [approvalItem(7, "대기첫건")] : [],
      page: { page: 0, offset: 20, total: box === "todo" ? 1 : 0, totalPage: 1, lastPage: true },
    }));
    approvalBridge(approvalList, approvalDoc);
    await act(async () => { root.render(<Approval />); });
    await flush();
    expect(approvalList).toHaveBeenCalledWith("todo", 0, "");
    expect(approvalDoc).toHaveBeenCalledWith(7);
    expect(document.querySelector(".approval-title h3")?.textContent).toBe("doc-7");
  });
});
