import { describe, expect, it } from "vitest";
import { approvalDocId, approvalOpenTarget, mailOpenTarget } from "../src/lib/home-open";

describe("dashboard open targets", () => {
  it("opens a mail row by folder and uid, including nested folders", () => {
    expect(mailOpenTarget({ id: "1201", folderFullName: "Inbox", seen: false })).toEqual({
      folder: "Inbox", uid: 1201, seen: false,
    });
    expect(mailOpenTarget({ id: "1200", folderFullName: "Inbox/업무 A", seen: true })).toEqual({
      folder: "Inbox/업무 A", uid: 1200, seen: true,
    });
    expect(mailOpenTarget({ id: "8", folderFullName: "  ", seen: false })?.folder).toBe("Inbox");
  });

  it("rejects a mail row that cannot be opened in-app", () => {
    expect(mailOpenTarget({ id: "nope", folderFullName: "Inbox", seen: false })).toBeNull();
    expect(mailOpenTarget({ id: "0", folderFullName: "Inbox", seen: false })).toBeNull();
    expect(mailOpenTarget({ id: "3", folderFullName: "Inbox\n", seen: false })).toBeNull();
  });

  it("opens an approval row in its box, preferring documentId the way the in-app screen does", () => {
    expect(approvalOpenTarget({ id: 501, documentId: 601 }, "todo")).toEqual({
      box: "todo", id: 501, documentId: 601,
    });
    expect(approvalDocId({ id: 501, documentId: 601 })).toBe(601);
    expect(approvalOpenTarget({ id: 11 }, "upcoming")).toEqual({ box: "upcoming", id: 11 });
    expect(approvalDocId({ id: 11 })).toBe(11);
  });

  it("rejects an approval row with no document id and never carries a host", () => {
    expect(approvalOpenTarget({ id: 0 }, "todo")).toBeNull();
    const mail = mailOpenTarget({ id: "4", folderFullName: "Sent", seen: true });
    const approval = approvalOpenTarget({ id: 9, documentId: 9 }, "todo");
    expect(JSON.stringify({ mail, approval })).not.toMatch(/https?:|ubion|dawer|daou/i);
  });
});
