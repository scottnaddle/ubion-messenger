import { describe, expect, it, vi } from "vitest";
import {
  MAIL_SEND_ENABLED, buildDraft, dedupeAddrs, draftAsText, isDraftDirty, mailSendBody, normalizeDraft, parseRecipients,
  prefixSubject, sendMail, validateDraft, type MailDraft,
} from "../electron/core/mail-compose";
import { PortalService } from "../electron/core/portal";
import { suggestRecipients } from "../src/components/MailCompose";
import type { MailMessage } from "../electron/core/mail";

const msg: MailMessage = {
  uid: 77, folder: "Inbox", subject: "견적서 송부", from: { name: "박지민", address: "jimin@example.org" },
  to: [{ name: "홍길동", address: "hong@example.com" }, { name: "이서준", address: "seojun@example.com" }],
  cc: [{ name: "김하늘", address: "sky@example.com" }, { name: "Jimin", address: "JIMIN@example.org" }],
  html: "<p>본문</p>", important: false, flagged: false, attachments: [],
};
const ok: MailDraft = { mode: "new", to: [{ name: "a", address: "a@b.co" }], cc: [], bcc: [], subject: "s", html: "<p>x</p>", attachments: [] };

describe("compose helpers", () => {
  it("parses recipients", () => {
    expect(parseRecipients('홍길동 <hong@example.com>, a@b.co; bad')).toEqual({
      addrs: [{ name: "홍길동", address: "hong@example.com" }, { name: "a@b.co", address: "a@b.co" }],
      invalid: ["bad"],
    });
  });
  it("prefixes subjects once", () => {
    expect(prefixSubject("RE", "hi")).toBe("RE: hi");
    expect(prefixSubject("RE", "Re: hi")).toBe("Re: hi");
    expect(prefixSubject("FW", "hi")).toBe("FW: hi");
  });
  it("reply → sender only; reply-all → others in Cc minus me & dups; forward → no recipients + quote", () => {
    const r = buildDraft("reply", msg, "hong@example.com", "<p>본문</p>");
    expect(r.to.map((a) => a.address)).toEqual(["jimin@example.org"]);
    expect(r.cc).toEqual([]);
    expect(r.subject).toBe("RE: 견적서 송부");
    expect(r.html).toContain("<blockquote");
    expect(r.html).toContain("<p>본문</p>");
    expect(r.html).toContain("From: 박지민 &lt;jimin@example.org&gt;");
    const ra = buildDraft("replyAll", msg, "HONG@example.com");
    expect(ra.to.map((a) => a.address)).toEqual(["jimin@example.org"]);
    expect(ra.cc.map((a) => a.address)).toEqual(["seojun@example.com", "sky@example.com"]);
    const f = buildDraft("forward", msg, "hong@example.com", "<p>본문</p>");
    expect(f.to).toEqual([]);
    expect(f.subject).toBe("FW: 견적서 송부");
    expect(f.ref).toEqual({ folder: "Inbox", uid: 77 });
    expect(buildDraft("new", null, "").subject).toBe("");
  });
  it("dedupes case-insensitively", () => {
    expect(dedupeAddrs([{ name: "", address: "A@b.co" }, { name: "", address: "a@B.co" }]).length).toBe(1);
  });
  it("validates", () => {
    expect(validateDraft(ok)).toBeNull();
    expect(validateDraft({ ...ok, to: [] })).toMatch("받는 사람");
    expect(validateDraft({ ...ok, cc: [{ name: "", address: "nope" }] })).toMatch("잘못된 주소");
  });
  it("dirty detection + text fallback", () => {
    expect(isDraftDirty(ok, ok)).toBe(false);
    expect(isDraftDirty({ ...ok, subject: "t" }, ok)).toBe(true);
    expect(draftAsText({ ...ok, html: "<p>안녕</p><p>a &amp; b</p>" })).toBe("받는 사람: a <a@b.co>\n제목: s\n\n안녕\na & b");
  });
  it("suggests org users by name/email, excluding picked", () => {
    const users = [{ name: "김하늘", email: "sky@example.com", position: "책임" }, { name: "김민수", email: "", position: "" }, { name: "이서준", email: "seojun@example.com", position: "" }];
    expect(suggestRecipients(users, "김", [])).toEqual([{ name: "김하늘 책임", address: "sky@example.com" }]);
    expect(suggestRecipients(users, "example", [{ name: "", address: "SKY@example.com" }]).map((s) => s.address)).toEqual(["seojun@example.com"]);
    expect(suggestRecipients(users, " ", [])).toEqual([]);
  });
  it("normalizes untrusted drafts at the IPC boundary", () => {
    expect(() => normalizeDraft({ mode: "spam" })).toThrow();
    expect(normalizeDraft({ mode: "new", to: [{ address: " a@b.co " }] }).to).toEqual([{ name: "", address: "a@b.co" }]);
  });
});

describe("send (fake network only)", () => {
  it("is disabled by default and never touches the network", async () => {
    expect(MAIL_SEND_ENABLED).toBe(false);
    const fetcher = vi.fn();
    await expect(sendMail(fetcher as any, ok)).rejects.toThrow("꺼져 있습니다");
    const svc = new PortalService(fetcher as any, () => undefined);
    await expect(svc.mailSend(ok)).rejects.toThrow("꺼져 있습니다");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("when force-enabled in tests: validates, refuses attachments, POSTs the (unverified) body", async () => {
    const fetcher = vi.fn(async () => ({ status: 200, text: '{"code":"200"}' }));
    await expect(sendMail(fetcher as any, { ...ok, to: [] }, true)).rejects.toThrow("받는 사람");
    await expect(sendMail(fetcher as any, { ...ok, attachments: [{ name: "a.pdf", size: 1 }] }, true)).rejects.toThrow("첨부");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(sendMail(fetcher as any, ok, true)).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith("/api/mail/message/send", { method: "POST", json: mailSendBody(ok) });
    const bad = vi.fn(async () => ({ status: 200, text: '{"code":"500","message":"수신자 오류"}' }));
    await expect(sendMail(bad as any, ok, true)).rejects.toThrow("수신자 오류");
  });
});
