import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { advertisedTools, resolveConnectors } from "../src/lib/connectors";
import { GoogleConnectorHost, type GoogleFetch } from "../electron/core/google-session";
import { extractPdfText } from "../electron/core/drive-pdf";
import {
  extractDocxText,
  extractXlsxText,
  htmlToText,
  pptxSlideToText,
  xmlToDocxText,
  xlsxSharedStrings,
  xlsxSheetToCsv,
} from "../electron/core/drive-text";
import {
  DRIVE_EMPTY_NOTE,
  DRIVE_READ_MAX_CHARS,
  DRIVE_RECONNECT_MESSAGE,
  DRIVE_SCAN_NOTE,
  GOOGLE_DRIVE_METADATA_SCOPE,
  GOOGLE_DRIVE_SCOPE,
  clipReadChars,
  driveExportUrl,
  driveFileMetaUrl,
  driveListUrl,
  driveMediaUrl,
  driveMimeClause,
  driveScopeAllowsContent,
  emptyTokenFile,
  isInsufficientDriveScope,
  putToken,
  routeDriveMime,
  truncateDriveText,
  type GoogleTokenFile,
} from "../electron/core/google-oauth";

const CLIENT = "1234567890-alpha.apps.googleusercontent.com";
const FILE_ID = "file_1";

function jsonResponse(status: number, body: unknown) {
  return { status, json: async () => body };
}

function bytesResponse(status: number, body: Uint8Array | string) {
  const bytes = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    status,
    json: async () => JSON.parse(Buffer.from(copy).toString("utf8")),
    arrayBuffer: async () => copy,
  };
}

function token(scope?: string, expiresAt = Date.now() + 3_600_000): GoogleTokenFile {
  return putToken(emptyTokenFile(), 7, "google-drive", {
    refreshToken: "1//refresh-token",
    accessToken: "ya29.access-token",
    expiresAt,
    ...(scope ? { scope } : {}),
  });
}

function host(opts: {
  file?: GoogleTokenFile;
  fetchImpl: GoogleFetch;
  extractPdf?: (bytes: Uint8Array) => Promise<string>;
  extractOffice?: (kind: "docx" | "xlsx" | "pptx", bytes: Uint8Array) => Promise<string>;
}) {
  let file = opts.file ?? token(GOOGLE_DRIVE_SCOPE);
  return {
    host: new GoogleConnectorHost({
      config: () => ({ clientId: CLIENT }),
      read: () => file,
      write: (next) => { file = next; },
      openBrowser: async () => { throw new Error("should not open"); },
      fetchImpl: opts.fetchImpl,
      extractPdf: opts.extractPdf,
      extractOffice: opts.extractOffice,
    }),
    stored: () => file,
  };
}

function minimalPdf(text: string): Buffer {
  const safe = text.replace(/[()\\]/g, "");
  const stream = `BT /F1 24 Tf 72 120 Td (${safe}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body);
}

async function officeZip(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, xml] of Object.entries(files)) zip.file(name, xml);
  return zip.generateAsync({ type: "uint8array" });
}

describe("drive search and read helpers", () => {
  it("searches by name and text, and can narrow mime and folder", () => {
    const broad = new URL(driveListUrl("a'b 보고서", 8));
    const q = broad.searchParams.get("q") || "";
    expect(q).toContain("a\\'b");
    expect(broad.toString()).toContain("a%5C%27b");
    expect(q).toContain("fullText contains");
    expect(q).toContain("name contains");
    expect(broad.searchParams.get("orderBy")).toBeNull();
    expect(broad.searchParams.get("fields")).toContain("parents");

    const named = new URL(driveListUrl("예산", 4, { mime: "pdf", folderId: "folder_1", contentSearch: false }));
    const nq = named.searchParams.get("q") || "";
    expect(nq).toContain("mimeType = 'application/pdf'");
    expect(nq).toContain("'folder_1' in parents");
    expect(nq).toContain("name contains '예산'");
    expect(nq).not.toContain("fullText");
    expect(named.searchParams.get("orderBy")).toBe("modifiedTime desc");
    expect(driveMimeClause("sheet")).toEqual({ ok: true, clause: "mimeType = 'application/vnd.google-apps.spreadsheet'" });
    expect(driveMimeClause("nope").ok).toBe(false);
    expect(driveScopeAllowsContent(undefined)).toBe(true);
    expect(driveScopeAllowsContent(GOOGLE_DRIVE_SCOPE)).toBe(true);
    expect(driveScopeAllowsContent(GOOGLE_DRIVE_METADATA_SCOPE)).toBe(false);
    expect(driveScopeAllowsContent("https://www.googleapis.com/auth/drive.file")).toBe(false);
  });

  it("builds read URLs and routes common document mimes", () => {
    expect(driveFileMetaUrl(FILE_ID)).toContain("fields=id%2Cname%2CmimeType%2Csize");
    expect(driveFileMetaUrl(FILE_ID)).not.toContain("alt=media");
    expect(driveExportUrl(FILE_ID, "text/plain")).toContain("/export");
    expect(driveExportUrl(FILE_ID, "text/csv")).toContain("text%2Fcsv");
    expect(driveMediaUrl(FILE_ID)).toContain("alt=media");
    expect(driveMediaUrl(FILE_ID)).not.toContain("upload");
    expect(routeDriveMime("application/vnd.google-apps.document")).toEqual({ kind: "export", exportMime: "text/plain" });
    expect(routeDriveMime("application/vnd.google-apps.spreadsheet")).toEqual({ kind: "export", exportMime: "text/csv" });
    expect(routeDriveMime("application/vnd.google-apps.presentation")).toEqual({ kind: "export", exportMime: "text/plain" });
    expect(routeDriveMime("application/pdf").kind).toBe("pdf");
    expect(routeDriveMime("text/markdown")).toEqual({ kind: "text", html: false });
    expect(routeDriveMime("text/csv")).toEqual({ kind: "text", html: false });
    expect(routeDriveMime("text/html; charset=utf-8")).toEqual({ kind: "text", html: true });
    expect(routeDriveMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document").kind).toBe("docx");
    expect(routeDriveMime("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").kind).toBe("xlsx");
    expect(routeDriveMime("application/vnd.openxmlformats-officedocument.presentationml.presentation").kind).toBe("pptx");
    for (const mime of ["image/png", "video/mp4", "audio/mpeg", "application/zip", "application/msword", "application/vnd.google-apps.folder"]) {
      const route = routeDriveMime(mime);
      expect(route.kind).toBe("unsupported");
      if (route.kind === "unsupported") expect(route.message).not.toMatch(/base64|data:/);
    }
    expect(clipReadChars(undefined)).toBe(12_000);
    expect(clipReadChars(0)).toBe(12_000);
    expect(clipReadChars(50_000)).toBe(DRIVE_READ_MAX_CHARS);
    const cut = truncateDriveText(`가나다라마바\u0000`, 5);
    expect(cut).toEqual({ text: "가나다라마", truncated: true });
    expect(truncateDriveText("짧음", 20).truncated).toBe(false);
  });

  it("detects insufficient scope without treating a single-file denial as a bad grant", () => {
    expect(isInsufficientDriveScope(403, {
      error: { errors: [{ reason: "insufficientPermissions", message: "Insufficient Permission" }], code: 403 },
    })).toBe(true);
    expect(isInsufficientDriveScope(403, {
      error: { code: 403, message: "Request had insufficient authentication scopes.", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] },
    })).toBe(true);
    expect(isInsufficientDriveScope(403, {
      error: { errors: [{ reason: "insufficientFilePermissions", message: "Insufficient Permission" }] },
    })).toBe(false);
    expect(isInsufficientDriveScope(404, { error: { errors: [{ reason: "insufficientPermissions" }] } })).toBe(false);
  });
});

describe("document text extraction", () => {
  it("turns html, docx, xlsx, and pptx xml into text", async () => {
    expect(htmlToText("<style>x</style><p>안녕&nbsp;<b>보고서</b></p><script>secret</script>")).toBe("안녕 보고서");
    expect(xmlToDocxText('<w:p><w:r><w:t>첫째</w:t></w:r></w:p><w:p><w:t>둘째 &amp; 끝</w:t></w:p>')).toBe("첫째\n둘째 & 끝");
    const shared = xlsxSharedStrings("<si><t>이름</t></si><si><t>유비온</t></si>");
    expect(xlsxSheetToCsv('<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c><v>3</v></c></row>', shared)).toBe("이름,유비온\n3");
    expect(pptxSlideToText("<a:t>표지</a:t><a:t>본문</a:t>")).toBe("표지\n본문");

    const docx = await officeZip({
      "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>분기 보고서</w:t></w:r></w:p></w:body></w:document>",
    });
    expect(await extractDocxText(docx)).toContain("분기 보고서");
    const xlsx = await officeZip({
      "xl/sharedStrings.xml": "<sst><si><t>항목</t></si></sst>",
      "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>12</v></c></row></sheetData></worksheet>',
    });
    expect(await extractXlsxText(xlsx)).toContain("항목,12");
  });

  it("extracts embedded PDF text and does not invent text for an empty parse", async () => {
    const text = await extractPdfText(minimalPdf("HelloPDF"));
    expect(text).toContain("HelloPDF");
  });
});

describe("google drive read host", () => {
  it("lists with a folder name and reads a Google Doc", async () => {
    const urls: string[] = [];
    const { host: reader } = host({
      fetchImpl: async (url) => {
        urls.push(url);
        const q = new URL(url).searchParams.get("q") || "";
        if (q.startsWith("id =")) return jsonResponse(200, { files: [{ id: "fld1", name: "보고서함" }] });
        if (url.includes("/export")) return bytesResponse(200, "1분기 매출 요약");
        if (url.includes("/drive/v3/files/file_1")) return jsonResponse(200, { id: FILE_ID, name: "매출.gdoc", mimeType: "application/vnd.google-apps.document" });
        if (url.includes("/drive/v3/files")) {
          return jsonResponse(200, { files: [{ id: FILE_ID, name: "매출.gdoc", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-01T00:00:00.000Z", parents: ["fld1"] }] });
        }
        throw new Error(url);
      },
    });
    const listed = await reader.driveList(7, { query: "매출", mime: "document", folderId: "fld1" });
    expect(listed).toEqual({
      ok: true,
      files: [{ id: FILE_ID, name: "매출.gdoc", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-01T00:00:00.000Z", folder: "보고서함" }],
    });
    expect(urls[0]).toContain("fullText");
    expect(urls[0]).toContain("mimeType");
    const read = await reader.driveRead(7, { fileId: FILE_ID, maxChars: 5 });
    expect(read).toEqual({ ok: true, name: "매출.gdoc", mimeType: "application/vnd.google-apps.document", text: "1분기 매", truncated: true });
    expect(advertisedTools(resolveConnectors({}, undefined, { "google-drive": true })).map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["google_drive_list", "google_drive_read"]),
    );
  });

  it("reads a sheet as csv, a pdf, and a docx without returning bytes", async () => {
    const docx = await officeZip({
      "word/document.xml": "<w:p><w:t>워드 본문</w:t></w:p>",
    });
    const { host: reader } = host({
      fetchImpl: async (url) => {
        if (url.includes("/export")) return bytesResponse(200, "열,값\n매출,10");
        if (url.includes("alt=media") && url.includes("pdf_1")) return bytesResponse(200, minimalPdf("ignored"));
        if (url.includes("alt=media") && url.includes("docx_1")) return bytesResponse(200, docx);
        if (url.includes("sheet_1")) return jsonResponse(200, { id: "sheet_1", name: "표", mimeType: "application/vnd.google-apps.spreadsheet" });
        if (url.includes("pdf_1")) return jsonResponse(200, { id: "pdf_1", name: "스캔.pdf", mimeType: "application/pdf", size: "1200" });
        if (url.includes("docx_1")) return jsonResponse(200, { id: "docx_1", name: "계약.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: "800" });
        throw new Error(url);
      },
      extractPdf: async () => "",
    });
    expect(await reader.driveRead(7, { fileId: "sheet_1" })).toMatchObject({ ok: true, text: "열,값\n매출,10", mimeType: "application/vnd.google-apps.spreadsheet" });
    expect(await reader.driveRead(7, { fileId: "pdf_1" })).toEqual({
      ok: true,
      name: "스캔.pdf",
      mimeType: "application/pdf",
      text: "",
      note: DRIVE_SCAN_NOTE,
    });
    const word = await reader.driveRead(7, { fileId: "docx_1" });
    expect(word).toMatchObject({ ok: true, name: "계약.docx", text: "워드 본문" });
    expect(JSON.stringify(word)).not.toMatch(/base64|PK/);
  });

  it("refuses binaries and oversized files without downloading them", async () => {
    const urls: string[] = [];
    const { host: reader } = host({
      fetchImpl: async (url) => {
        urls.push(url);
        if (url.includes("img_1")) return jsonResponse(200, { id: "img_1", name: "사진.png", mimeType: "image/png", size: "40" });
        if (url.includes("zip_1")) return jsonResponse(200, { id: "zip_1", name: "묶음.zip", mimeType: "application/zip" });
        if (url.includes("big_1")) return jsonResponse(200, { id: "big_1", name: "큰.pdf", mimeType: "application/pdf", size: String(21 * 1024 * 1024) });
        throw new Error(url);
      },
    });
    const image = await reader.driveRead(7, { fileId: "img_1" });
    expect(image).toMatchObject({ ok: false, code: "unsupported" });
    expect(JSON.stringify(image)).not.toMatch(/base64/);
    expect(await reader.driveRead(7, { fileId: "zip_1" })).toMatchObject({ ok: false, code: "unsupported" });
    expect(await reader.driveRead(7, { fileId: "big_1" })).toMatchObject({ ok: false, code: "too-large" });
    expect(urls.some((url) => url.includes("alt=media"))).toBe(false);
    expect(await reader.driveRead(7, {})).toMatchObject({ ok: false, code: "file" });
    expect(await reader.driveRead(7, { fileId: "../etc" })).toMatchObject({ ok: false, code: "file" });
  });

  it("clears a metadata-only Drive token and asks for 연결 again", async () => {
    const urls: string[] = [];
    const stale = host({
      file: token(GOOGLE_DRIVE_METADATA_SCOPE),
      fetchImpl: async (url) => {
        urls.push(url);
        if (url.includes("/drive/v3/files?")) {
          return jsonResponse(200, { files: [{ id: FILE_ID, name: "메모.txt", mimeType: "text/plain" }] });
        }
        throw new Error(url);
      },
    });
    const listed = await stale.host.driveList(7, { query: "메모" });
    expect(listed).toMatchObject({ ok: true, note: expect.stringContaining("연결") });
    expect(urls[0]).not.toContain("fullText");
    expect(stale.stored().byUser["7"]?.["google-drive"]).toBeTruthy();

    const read = await stale.host.driveRead(7, { fileId: FILE_ID });
    expect(read).toEqual({ ok: false, code: "reconnect", message: DRIVE_RECONNECT_MESSAGE });
    expect(urls.some((url) => url.includes("/files/file_1"))).toBe(false);
    expect(stale.stored().byUser["7"]?.["google-drive"]).toBeUndefined();
    expect(JSON.stringify(read)).not.toContain("ya29");
  });

  it("clears the token when Google returns insufficient scope and keeps it for a file ACL miss", async () => {
    const denied = host({
      file: token(),
      fetchImpl: async () => jsonResponse(403, { error: { errors: [{ reason: "insufficientPermissions", message: "Insufficient Permission" }] } }),
    });
    delete denied.stored().byUser["7"]!["google-drive"]!.scope;
    expect(await denied.host.driveRead(7, { fileId: FILE_ID })).toMatchObject({ ok: false, code: "reconnect", message: DRIVE_RECONNECT_MESSAGE });
    expect(denied.stored().byUser["7"]?.["google-drive"]).toBeUndefined();

    const acl = host({
      file: token(GOOGLE_DRIVE_SCOPE),
      fetchImpl: async () => jsonResponse(403, { error: { errors: [{ reason: "insufficientFilePermissions", message: "The user does not have access" }] } }),
    });
    expect(await acl.host.driveRead(7, { fileId: FILE_ID })).toMatchObject({ ok: false, code: "forbidden" });
    expect(acl.stored().byUser["7"]?.["google-drive"]?.refreshToken).toBe("1//refresh-token");
  });

  it("returns the empty-office note and does not echo a broken zip", async () => {
    const marker = "NOTAZIPMARKER";
    const { host: reader } = host({
      fetchImpl: async (url) => {
        if (url.includes("alt=media")) return bytesResponse(200, Buffer.from(marker));
        return jsonResponse(200, { id: "bad_1", name: "깨짐.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: "20" });
      },
    });
    const result = await reader.driveRead(7, { fileId: "bad_1" });
    expect(result).toMatchObject({ ok: false, code: "extract" });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(DRIVE_EMPTY_NOTE).toContain("텍스트를 추출하지 못했습니다");

    const empty = host({
      fetchImpl: async (url) => {
        if (url.includes("alt=media")) return bytesResponse(200, new Uint8Array());
        return jsonResponse(200, { id: "empty_1", name: "빈.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
      },
      extractOffice: async () => "",
    });
    expect(await empty.host.driveRead(7, { fileId: "empty_1" })).toEqual({
      ok: true,
      name: "빈.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      text: "",
      note: DRIVE_EMPTY_NOTE,
    });
  });
});
