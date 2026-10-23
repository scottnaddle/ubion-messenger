import { describe, expect, it, vi } from "vitest";
import { MAIL_DELETE_ENABLED, applyMailDelete, deleteMail, isTrashFolder, mailDeleteBody, normalizeMailDeleteArgs } from "../electron/core/mail";
import { PortalService } from "../electron/core/portal";

describe("mail delete (fake network)", () => {
  it("body matches the capture: parallel folderNames/uids, uids as strings", () => {
    expect(mailDeleteBody({ folder: "Inbox", uids: [67572] })).toEqual({ folderNames: ["Inbox"], uids: ["67572"] });
    expect(mailDeleteBody({ folder: "Inbox/업무", uids: [1, 2] })).toEqual({ folderNames: ["Inbox/업무", "Inbox/업무"], uids: ["1", "2"] });
  });
  it("validates args (dedupe, empty, bad uid, too many)", () => {
    expect(normalizeMailDeleteArgs("Inbox", [3, 3, "4"]).uids).toEqual([3, 4]);
    expect(() => normalizeMailDeleteArgs("Inbox", [])).toThrow("선택");
    expect(() => normalizeMailDeleteArgs("Inbox", [-1])).toThrow();
    expect(() => normalizeMailDeleteArgs("Inbox", Array.from({ length: 201 }, (_, i) => i + 1))).toThrow("200");
  });
  it("POSTs to /api/mail/message/delete; code != 200 → failure", async () => {
    expect(MAIL_DELETE_ENABLED).toBe(true);
    const f = vi.fn(async () => ({ status: 200, text: '{"code":"200","message":"OK"}' }));
    await expect(deleteMail(f as any, "Inbox", [67572], true)).resolves.toEqual({ ok: true, count: 1 });
    expect(f).toHaveBeenCalledWith("/api/mail/message/delete", { method: "POST", json: { folderNames: ["Inbox"], uids: ["67572"] } });
    await expect(deleteMail(vi.fn(async () => ({ status: 200, text: "" })) as any, "Inbox", [1], true)).resolves.toBeTruthy();
    await expect(deleteMail(vi.fn(async () => ({ status: 200, text: '{"code":"500","message":"권한 없음"}' })) as any, "Inbox", [1], true)).rejects.toThrow("권한 없음");
    await expect(deleteMail(vi.fn(async () => ({ status: 403, text: "" })) as any, "Inbox", [1], true)).rejects.toThrow("HTTP 403");
    const off = vi.fn();
    await expect(deleteMail(off as any, "Inbox", [1], false)).rejects.toThrow("꺼져");
    expect(off).not.toHaveBeenCalled();
  });
  it("PortalService.mailDelete goes through the fetcher; mailCaps reports enabled", async () => {
    const f = vi.fn(async () => ({ status: 200, text: '{"code":"200"}' }));
    const svc = new PortalService(f as any, () => undefined);
    expect(svc.mailCaps()).toEqual({ delete: true });
    await svc.mailDelete("Trash", ["9"]);
    expect((f.mock.calls[0] as any)[1].json).toEqual({ folderNames: ["Trash"], uids: ["9"] });
    await expect(svc.mailDelete("a\nb", [1])).rejects.toThrow();
  });
  it("isTrashFolder", () => {
    expect(isTrashFolder("Trash")).toBe(true);
    expect(isTrashFolder("x", "휴지통")).toBe(true);
    expect(isTrashFolder("Inbox", "받은편지함")).toBe(false);
  });
  it("applyMailDelete: removal, unread count, next selection (next, else previous)", () => {
    const it = (uid: number, seen = true) => ({ uid, folder: "Inbox", seen });
    const items = [it(5), it(4, false), it(3), it(2, false)];
    expect(applyMailDelete(items, "Inbox", [4, 2], 4)).toEqual({ remaining: [it(5), it(3)], unreadRemoved: 2, next: it(3) });
    expect(applyMailDelete(items, "Inbox", [2], 2).next).toEqual(it(3));
    expect(applyMailDelete(items, "Inbox", [5], 3).next).toBeNull();
    expect(applyMailDelete([it(1)], "Inbox", [1], 1).next).toBeNull();
  });
});
