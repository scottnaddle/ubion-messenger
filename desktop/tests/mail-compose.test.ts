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

const ME = { name: "테스터", email: "tester@example.com" };
const CAPTURE_KEYS = ["attachList","attachSign","attachsign","bannerDisplay","bcc","bigAttachContent","bigAttachLinks","bigAttachMode","cc","charset","content","massMode","receiveNoti","saveSent","sendAttachCheckResult","sendEmailCheckResult","sendFlag","sendInfoCheck","sendKeywordCheckResult","sendType","senderEmail","senderMode","senderName","senderUserEmail","sharedFlag","sharedFolderName","sharedUserSeq","signLocation","signSeq","subject","to","useAliasEmail","writeMode"];

describe("send (fake network only)", () => {
  it("is enabled and builds exactly the captured body", () => {
    expect(MAIL_SEND_ENABLED).toBe(true);
    const d = { ...ok, to: [{ name: "홍길동", address: "hong@example.com" }, { name: "", address: "x@y.co" }], cc: [{ name: "김", address: "k@y.co" }], bcc: [{ name: "B", address: "b@y.co" }], subject: "test" };
    const b = mailSendBody(d, ME);
    expect(Object.keys(b).sort()).toEqual([...CAPTURE_KEYS].sort());
    expect(b).toMatchObject({
      attachList: "", attachSign: true, attachsign: true, bannerDisplay: false, bigAttachContent: "", bigAttachLinks: null, bigAttachMode: false,
      charset: "UTF-8", massMode: false, receiveNoti: true, saveSent: true, sendFlag: "normal", sendType: "normal", senderMode: true,
      sharedFlag: "user", sharedFolderName: "", sharedUserSeq: "0", signLocation: "outside", signSeq: "1", useAliasEmail: false, writeMode: "html",
      to: '"홍길동" <hong@example.com>, x@y.co', cc: '"김" <k@y.co>', bcc: '"B" <b@y.co>', subject: "test",
      senderEmail: "tester@example.com", senderName: "테스터", senderUserEmail: '"테스터" <tester@example.com>',
      content: "<div class='TerraceMsg'><p>x</p></div>",
    });
    expect(mailSendBody({ ...ok, to: [{ name: 'a"b', address: "a@b.co" }] }, ME).to).toBe('"ab" <a@b.co>');
  });
  it("disabled flag → never touches the network", async () => {
    const fetcher = vi.fn();
    await expect(sendMail(fetcher as any, ok, ME, false)).rejects.toThrow("꺼져");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("validates, refuses attachments / missing sender before any request", async () => {
    const fetcher = vi.fn();
    await expect(sendMail(fetcher as any, { ...ok, to: [] }, ME)).rejects.toThrow("받는 사람");
    await expect(sendMail(fetcher as any, { ...ok, attachments: [{ name: "a.pdf", size: 1, status: "uploading" }] }, ME)).rejects.toThrow("업로드가 끝난 뒤");
    await expect(sendMail(fetcher as any, { ...ok, attachments: [{ name: "a.pdf", size: 1, status: "error" }] }, ME)).rejects.toThrow("실패한 첨부");
    await expect(sendMail(fetcher as any, ok, null)).rejects.toThrow("보내는 사람");
    await expect(sendMail(fetcher as any, ok, { name: "x", email: "" })).rejects.toThrow("보내는 사람");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("POSTs to /api/mail/message/send and maps responses", async () => {
    const fetcher = vi.fn(async () => ({ status: 200, text: '{"code":"200","message":"OK"}' }));
    await expect(sendMail(fetcher as any, ok, ME)).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith("/api/mail/message/send", { method: "POST", json: mailSendBody(ok, ME) });
    const bad = vi.fn(async () => ({ status: 200, text: '{"code":"500","message":"수신자 오류"}' }));
    await expect(sendMail(bad as any, ok, ME)).rejects.toThrow("수신자 오류");
    const bad2 = vi.fn(async () => ({ status: 200, text: '{"code":"403"}' }));
    await expect(sendMail(bad2 as any, ok, ME)).rejects.toThrow("code 403");
    const bad3 = vi.fn(async () => ({ status: 502, text: "<html>" }));
    await expect(sendMail(bad3 as any, ok, ME)).rejects.toThrow("HTTP 502");
  });
  it("PortalService.mailSend uses session sender and IPC-normalized draft", async () => {
    const fetcher = vi.fn(async () => ({ status: 200, text: '{"code":"200"}' }));
    const svc = new PortalService(fetcher as any, () => undefined);
    await expect(svc.mailSend(ok)).rejects.toThrow("보내는 사람");
    expect(fetcher).not.toHaveBeenCalled();
    svc.getSender = async () => ME;
    await svc.mailSend({ ...ok, extra: "ignored" });
    expect((fetcher.mock.calls[0] as any)[1].json.senderEmail).toBe("tester@example.com");
    await expect(svc.mailSend({ mode: "bogus" })).rejects.toThrow();
  });
  it("reply/forward are sent as plain new mails (sendType normal, quoted content)", () => {
    const r = buildDraft("reply", msg, "hong@example.com", "<p>본문</p>");
    const b = mailSendBody(r, ME);
    expect(b.sendType).toBe("normal");
    expect(b.subject).toBe("RE: 견적서 송부");
    expect(b.content).toContain("<blockquote");
    expect(b).not.toHaveProperty("uid");
  });
});
