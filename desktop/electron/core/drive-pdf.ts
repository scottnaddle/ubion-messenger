/**
 * PDF text for 내 봇. Embedded text only — no OCR. A scanned page comes back empty.
 * Loaded with createRequire so pdf-parse's debug branch (no module.parent) does not run.
 */
import { createRequire } from "node:module";

type PdfParseFn = (data: Uint8Array) => Promise<{ text?: string }>;

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const require = createRequire(import.meta.url);
  const loaded = require("pdf-parse") as PdfParseFn | { default?: PdfParseFn };
  const pdfParse = typeof loaded === "function" ? loaded : loaded.default;
  if (typeof pdfParse !== "function") throw new Error("pdf-parse");
  // pdf.js 1.10 misreads a Node Buffer that views a larger pool. Copy into an exact ArrayBuffer.
  const exact = new Uint8Array(bytes.byteLength);
  exact.set(bytes);
  const parsed = await pdfParse(exact);
  return typeof parsed?.text === "string" ? parsed.text : "";
}
