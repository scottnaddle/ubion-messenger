/**
 * Mail compose attachments (v1.0.14). Request/response VERIFIED from Scott's DevTools capture (2026-10-23):
 *   POST /api/mail/file/upload  multipart/form-data, fields in order:
 *     uploadType="flash", maxAttachFileSize="20", theFile=<file; filename; content-type>
 *   response (Content-Type text/plain, JSON text):
 *     {"attachMode":"normal","uid":0,"fileName":"…","uploadResult":"success","fileSize":238893,"filePath":"/202643/06C5…","hostId":"TMUz…"}
 *   send body attachList = concat of `${filePath}\t${fileName}\t${fileSize}\t${hostId}\t0\n`
 */
export const MAIL_UPLOAD_PATH = "/api/mail/file/upload";
export const MAIL_ATTACH_MAX_MB = 20;
export const MAIL_ATTACH_MAX_BYTES = MAIL_ATTACH_MAX_MB * 1024 * 1024;

export type UploadedAttach = { filePath: string; fileName: string; fileSize: number; hostId: string };

export const tooBigMessage = (name: string) =>
  `'${name}' 파일이 ${MAIL_ATTACH_MAX_MB}MB를 넘습니다. ${MAIL_ATTACH_MAX_MB}MB보다 큰 파일은 웹 메일의 대용량 첨부를 이용해 주세요.`;

const q = (s: string) => s.replace(/[\r\n"]/g, "_");

/** multipart body exactly as the web client sends it. */
export function buildUploadMultipart(file: { name: string; data: Uint8Array; mime?: string }, boundary: string): Uint8Array {
  const enc = new TextEncoder();
  const part = (name: string, v: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${v}\r\n`;
  const chunks = [
    enc.encode(part("uploadType", "flash") + part("maxAttachFileSize", String(MAIL_ATTACH_MAX_MB))),
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="theFile"; filename="${q(file.name)}"\r\nContent-Type: ${q(file.mime || "application/octet-stream")}\r\n\r\n`),
    file.data,
    enc.encode(`\r\n--${boundary}--\r\n`),
  ];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

/** Success iff uploadResult=="success" and filePath + hostId present. Fails closed otherwise. */
export function parseUploadResponse(status: number, text: string, fallbackName: string, fallbackSize: number): UploadedAttach {
  if (status !== 200) throw new Error(`첨부 업로드 실패 (HTTP ${status})`);
  let o: any;
  try { o = JSON.parse(String(text).trim()); } catch { throw new Error("첨부 업로드 응답을 해석할 수 없습니다"); }
  if (o?.uploadResult !== "success") throw new Error(`첨부 업로드 실패${o?.uploadResult ? ` (${o.uploadResult})` : ""}${o?.message ? `: ${o.message}` : ""}`);
  const filePath = typeof o.filePath === "string" ? o.filePath : "";
  const hostId = typeof o.hostId === "string" ? o.hostId : "";
  if (!filePath || !hostId) throw new Error("첨부 업로드 응답에 파일 정보(filePath/hostId)가 없습니다");
  const fileName = (typeof o.fileName === "string" && o.fileName) || fallbackName;
  const fileSize = Number.isFinite(Number(o.fileSize)) && Number(o.fileSize) >= 0 ? Number(o.fileSize) : fallbackSize;
  return { filePath, fileName, fileSize, hostId };
}

const clean = (s: string) => String(s).replace(/[\t\r\n]/g, " ");
export function attachListString(list: UploadedAttach[]): string {
  return list.map((a) => `${clean(a.filePath)}\t${clean(a.fileName)}\t${Math.trunc(a.fileSize)}\t${clean(a.hostId)}\t0\n`).join("");
}

export type Uploader = (path: string, body: Uint8Array, contentType: string) => Promise<{ status: number; text: string }>;

export async function uploadMailAttachment(upload: Uploader, file: { name: string; data: Uint8Array; mime?: string }): Promise<UploadedAttach> {
  const name = String(file.name || "file");
  if (!file.data || file.data.byteLength === 0) throw new Error(`'${name}' 파일이 비어 있습니다`);
  if (file.data.byteLength > MAIL_ATTACH_MAX_BYTES) throw new Error(tooBigMessage(name));
  const boundary = "----WebKitFormBoundary" + Math.random().toString(36).slice(2, 18);
  const res = await upload(MAIL_UPLOAD_PATH, buildUploadMultipart({ ...file, name }, boundary), `multipart/form-data; boundary=${boundary}`);
  return parseUploadResponse(res.status, res.text, name, file.data.byteLength);
}
