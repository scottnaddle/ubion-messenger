import { describe, expect, it, vi } from "vitest";
import { MAIL_ATTACH_MAX_BYTES, attachListString, buildUploadMultipart, parseUploadResponse, uploadMailAttachment } from "../electron/core/mail-attach";
import { mailSendBody, normalizeDraft, sendMail, type MailDraft } from "../electron/core/mail-compose";
import { PortalService } from "../electron/core/portal";

const RESP = '{"attachMode":"normal","uid":0,"fileName":"EDCF 보고.rtf","uploadResult":"success","fileSize":238893,"filePath":"/202643/06C53E8F125642A69B4F0C8488260B54","hostId":"TMUzAwMDAwMEEtNzg1"}';
const UP = { filePath: "/202643/06C53E8F125642A69B4F0C8488260B54", fileName: "EDCF 보고.rtf", fileSize: 238893, hostId: "TMUzAwMDAwMEEtNzg1" };
const ME = { name: "테스터", email: "tester@example.com" };
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

describe("mail upload (fake network)", () => {
  it("multipart fields in captured order: uploadType, maxAttachFileSize, theFile", () => {
    const body = dec(buildUploadMultipart({ name: 'a"b.pdf', data: new TextEncoder().encode("PDFDATA"), mime: "application/pdf" }, "BND"));
    expect(body).toBe(
      '--BND\r\nContent-Disposition: form-data; name="uploadType"\r\n\r\nflash\r\n' +
      '--BND\r\nContent-Disposition: form-data; name="maxAttachFileSize"\r\n\r\n20\r\n' +
      '--BND\r\nContent-Disposition: form-data; name="theFile"; filename="a_b.pdf"\r\nContent-Type: application/pdf\r\n\r\nPDFDATA\r\n--BND--\r\n');
  });
  it("parses the captured text/plain JSON", () => {
    expect(parseUploadResponse(200, RESP + "\n", "x", 1)).toEqual(UP);
  });
  it("fails closed", () => {
    expect(() => parseUploadResponse(500, RESP, "x", 1)).toThrow("HTTP 500");
    expect(() => parseUploadResponse(200, "<html>", "x", 1)).toThrow("해석");
    expect(() => parseUploadResponse(200, '{"uploadResult":"fail"}', "x", 1)).toThrow("(fail)");
    expect(() => parseUploadResponse(200, '{"uploadResult":"success","filePath":"/a"}', "x", 1)).toThrow("hostId");
    expect(() => parseUploadResponse(200, '{"uploadResult":"success","hostId":"h"}', "x", 1)).toThrow("filePath");
  });
  it("attachList line format, concatenated per file", () => {
    expect(attachListString([UP, { ...UP, fileName: "b\tc.png", fileSize: 10, hostId: "H2" }])).toBe(
      "/202643/06C53E8F125642A69B4F0C8488260B54\tEDCF 보고.rtf\t238893\tTMUzAwMDAwMEEtNzg1\t0\n" +
      "/202643/06C53E8F125642A69B4F0C8488260B54\tb c.png\t10\tH2\t0\n");
    expect(attachListString([])).toBe("");
  });
  it("uploadMailAttachment: POSTs multipart to /api/mail/file/upload; 20MB / empty refused without network", async () => {
    const up = vi.fn(async () => ({ status: 200, text: RESP }));
    await expect(uploadMailAttachment(up, { name: "EDCF 보고.rtf", data: new Uint8Array(5) })).resolves.toEqual(UP);
    const [path, , ct] = up.mock.calls[0] as any;
    expect(path).toBe("/api/mail/file/upload");
    expect(ct).toMatch(/^multipart\/form-data; boundary=----WebKitFormBoundary/);
    const big = vi.fn();
    await expect(uploadMailAttachment(big, { name: "big.zip", data: new Uint8Array(MAIL_ATTACH_MAX_BYTES + 1) })).rejects.toThrow("대용량 첨부");
    await expect(uploadMailAttachment(big, { name: "e.txt", data: new Uint8Array(0) })).rejects.toThrow("비어");
    expect(big).not.toHaveBeenCalled();
    await expect(uploadMailAttachment(big, { name: "ok.txt", data: new Uint8Array(MAIL_ATTACH_MAX_BYTES) })).rejects.toThrow();
    expect(big).toHaveBeenCalledTimes(1);
  });
  it("PortalService.mailUpload strips path from name and needs login", async () => {
    const svc = new PortalService(vi.fn() as any, () => undefined);
    await expect(svc.mailUpload("a.txt", new ArrayBuffer(1))).rejects.toThrow("로그인");
    const up = vi.fn(async () => ({ status: 200, text: RESP }));
    svc.uploader = up;
    await svc.mailUpload("../../x/a.txt", new ArrayBuffer(3));
    expect(dec((up.mock.calls[0] as any)[1])).toContain('filename="a.txt"');
    await expect(svc.mailUpload("a", "str")).rejects.toThrow("invalid");
  });
});

describe("send with attachments", () => {
  const base: MailDraft = { mode: "new", to: [{ name: "", address: "a@b.co" }], cc: [], bcc: [], subject: "s", html: "x", attachments: [] };
  it("attachList built from uploads; other fields unchanged", async () => {
    const d = { ...base, attachments: [{ name: UP.fileName, size: UP.fileSize, status: "done" as const, uploaded: UP }] };
    const b = mailSendBody(d, ME);
    expect(b.attachList).toBe(attachListString([UP]));
    expect(b.attachSign).toBe(true);
    expect(mailSendBody(base, ME).attachList).toBe("");
    const f = vi.fn(async () => ({ status: 200, text: '{"code":"200"}' }));
    await sendMail(f as any, normalizeDraft(JSON.parse(JSON.stringify(d))), ME);
    expect((f.mock.calls[0] as any)[1].json.attachList).toBe(attachListString([UP]));
  });
  it("normalizeDraft drops forged/incomplete uploads → send refused", async () => {
    const n = normalizeDraft({ ...base, attachments: [{ name: "x", size: 1, status: "done", uploaded: { filePath: "/a" } }] });
    expect(n.attachments[0].uploaded).toBeUndefined();
    const f = vi.fn();
    await expect(sendMail(f as any, n, ME)).rejects.toThrow("실패한 첨부");
    expect(f).not.toHaveBeenCalled();
  });
});
