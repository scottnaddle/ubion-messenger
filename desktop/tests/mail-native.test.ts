// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  isAllowedMailPost, mailListBody, mailOverview, normalizeMailListArgs, normalizeMailUid, parseAddr, parseMailList, parseMailMessage, validFolder,
} from "../electron/core/mail";
import { isAllowedPortalPath, PortalService } from "../electron/core/portal";
import { sanitizeMailHtml } from "../src/lib/sanitize";
import { mailDate } from "../src/components/Mail";

// Shapes captured live from coco.ubion.co.kr (values replaced with made-up data).
const listBody = {
  code: "200", message: "OK",
  data: {
    folderName: "받은편지함", folderFullName: "Inbox", total: 45, unreadMessageCount: 7,
    pageInfo: { page: 1, pageSize: 20, total: 45, lastPage: false },
    messageList: [
      { id: 101, folderFullName: "Inbox", subject: "회의록", from: "\"김하늘\"<sky@example.com>", preview: "  안녕하세요\n 공유드립니다 ", dateUtc: "2026-10-23T00:25:07.000Z", seen: false, flag: "T", priority: "NORMAL", size: "10.3KB" },
      { id: 100, folderFullName: "Inbox", subject: "견적", from: "only@example.org", preview: "", dateUtc: "2026-10-22T07:36:11.000Z", seen: true, flag: "SAF", priority: "HIGH", size: "1KB" },
      { id: 0, subject: "bad" },
    ],
  },
};

describe("mail list/read parsing", () => {
  it("parses list items, flags and paging", () => {
    const r = parseMailList(listBody, "Inbox");
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ uid: 101, seen: false, hasAttach: true, flagged: false, important: false, from: { name: "김하늘", address: "sky@example.com" }, preview: "안녕하세요 공유드립니다" });
    expect(r.items[1]).toMatchObject({ seen: true, answered: true, flagged: true, important: true, from: { name: "only@example.org", address: "only@example.org" } });
    expect(r).toMatchObject({ total: 45, unread: 7, page: 1, pageSize: 20, lastPage: false, folderName: "받은편지함" });
  });
  it("treats an empty folder (no messageList) as last page", () => {
    const r = parseMailList({ data: { total: 0, pageInfo: { page: 1, pageSize: 30, total: 0 } } }, "Sent");
    expect(r.items).toEqual([]);
    expect(r.lastPage).toBe(true);
  });
  it("parses a message with recipients and attachments", () => {
    const m = parseMailMessage({ data: { msgContent: {
      uid: 55, folderFullName: "Inbox", subject: "s", from: "\"x\"<a@b.c>", fromPersonal: "박지민", dateUtc: "2026-10-22T01:00:00Z",
      htmlContent: "<p>hi</p>", priority: "NORMAL", flaged: true, toList: [{ personal: "홍길동", address: "h@x.com" }],
      attachList: [{ path: "1", fileName: "a.docx", size: 54868, fileType: "docx", fsize: "53.6KB" }],
    } } }, "Inbox");
    expect(m.from).toEqual({ name: "박지민", address: "a@b.c" });
    expect(m.to).toEqual([{ name: "홍길동", address: "h@x.com" }]);
    expect(m.cc).toEqual([]);
    expect(m.attachments[0]).toEqual({ part: "1", name: "a.docx", size: 54868, sizeLabel: "53.6KB", type: "docx" });
    expect(m.flagged).toBe(true);
    expect(parseMailMessage(null, "Inbox").attachments).toEqual([]);
  });
  it("parses address forms", () => {
    expect(parseAddr('""홍""<h@x>')).toEqual({ name: "홍", address: "h@x" });
    expect(parseAddr("Kim <k@x>")).toEqual({ name: "Kim", address: "k@x" });
  });
});

describe("mail argument validation + POST whitelist", () => {
  it("builds the live-verified list body (1-based page + offset, keyWord)", () => {
    expect(mailListBody(normalizeMailListArgs("Inbox", 2, " 회의 "))).toEqual({ folder: "Inbox", page: 2, offset: 30, keyWord: "회의" });
    expect(mailListBody(normalizeMailListArgs("Sent", 1, ""))).toEqual({ folder: "Sent", page: 1, offset: 30 });
  });
  it("rejects bad args", () => {
    expect(() => normalizeMailListArgs("Inbox", 0)).toThrow(/page/);
    expect(() => normalizeMailListArgs("", 1)).toThrow(/folder/);
    expect(() => normalizeMailListArgs("In\nbox", 1)).toThrow(/folder/);
    expect(() => normalizeMailListArgs("Inbox", 1, "x".repeat(101))).toThrow(/keyword/);
    expect(() => normalizeMailUid("1;2")).toThrow(/uid/);
    expect(normalizeMailUid("67554")).toBe(67554);
    expect(validFolder("Inbox/업무")).toBe("Inbox/업무");
  });
  it("only list/read may be POSTed; never send/delete/move", () => {
    expect(isAllowedMailPost("/api/mail/message/list")).toBe(true);
    expect(isAllowedMailPost("/api/mail/message/read")).toBe(true);
    for (const p of ["/api/mail/message/send", "/api/mail/message/delete", "/api/mail/message/move", "/api/mail/message/list/../send", "/api/mail/message/read?x=1", "/api/mail/message/flag"]) expect(isAllowedMailPost(p)).toBe(false);
    expect(isAllowedPortalPath("/api/mail/message/list")).toBe(false); // still not a GET path
  });
  it("PortalService.post refuses non-whitelisted paths without hitting the network", async () => {
    const fetcher = vi.fn(async () => ({ status: 200, text: JSON.stringify(listBody) }));
    const svc = new PortalService(fetcher, () => undefined);
    await expect(svc.post("/api/mail/message/send", {})).rejects.toThrow(/not allowed/);
    expect(fetcher).not.toHaveBeenCalled();
    const r = await svc.mailList("Inbox", 1, "");
    expect(fetcher).toHaveBeenCalledWith("/api/mail/message/list", { method: "POST", json: { folder: "Inbox", page: 1, offset: 30 } });
    expect(r.items).toHaveLength(2);
  });
});

describe("mail HTML sanitizing", () => {
  const html = '<p onclick="x()">hi</p><script>alert(1)</script><style>body{}</style><img src="https://t.example.com/p.gif" width="1"><img src="data:image/png;base64,AAAA"><div style="background:url(https://t.example.com/b.png)">x</div><a href="https://example.com" target="_self">l</a><a href="javascript:alert(1)">j</a><iframe src="https://e.com"></iframe><form><input></form>';
  it("strips scripts/handlers/iframes/forms and blocks remote images by default", () => {
    const r = sanitizeMailHtml(html);
    expect(r.html).not.toMatch(/script|onclick|iframe|<form|<input|<style|javascript:/i);
    expect(r.html).not.toContain("t.example.com");
    expect(r.html).toContain("data:image/png");
    expect(r.blockedImages).toBe(2);
    expect(r.html).toContain('data-ext-href="https://example.com"');
    expect(r.html).not.toContain("target=");
  });
  it("shows remote https images on request", () => {
    const r = sanitizeMailHtml(html, true);
    expect(r.html).toContain("https://t.example.com/p.gif");
    expect(r.blockedImages).toBe(0);
    expect(r.html).not.toMatch(/script|javascript:/i);
  });
});

describe("overview + dates", () => {
  it("summarises unread/important/attachments and recent senders", () => {
    const o = mailOverview(parseMailList(listBody, "Inbox"), 7);
    expect(o).toMatchObject({ unread: 7, unreadOnPage: 1, important: 1, withAttach: 1 });
    expect(o.recentSenders.map((s) => s.address)).toEqual(["sky@example.com", "only@example.org"]);
    expect(mailOverview(null, 0).recentSenders).toEqual([]);
  });
  it("formats list dates", () => {
    const now = new Date("2026-10-23T12:00:00");
    expect(mailDate("2026-10-23T09:05:00", now)).toMatch(/09:05/);
    expect(mailDate("2026-03-02T09:05:00", now)).toBe("3.2");
    expect(mailDate("2025-03-02T09:05:00", now)).toBe("2025.3.2");
  });
});
