/**
 * Best-effort text from HTML and Office Open XML (docx, xlsx, pptx).
 * Pure JS via jszip. No native addons. Images inside the package are ignored.
 */
import JSZip from "jszip";

const XML_CAP = 2_000_000;
const TEXT_CAP = 20_001;

export function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCode(Number(dec)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function safeCode(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

export function htmlToText(html: string): string {
  return decodeXml(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function xmlToDocxText(xml: string): string {
  const lines: string[] = [];
  for (const para of xml.split(/<\/w:p>/i)) {
    const bits = [...para.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)].map((match) => decodeXml(match[1] ?? ""));
    const line = bits.join("").replace(/\u0000/g, "").trim();
    if (line) lines.push(line);
    if (lines.join("\n").length >= TEXT_CAP) break;
  }
  return lines.join("\n").slice(0, TEXT_CAP).trim();
}

export function xlsxSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const block of xml.split(/<si\b[^>]*>/i).slice(1)) {
    const end = block.search(/<\/si>/i);
    const inner = end >= 0 ? block.slice(0, end) : block;
    out.push([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((match) => decodeXml(match[1] ?? "")).join(""));
    if (out.length > 50_000) break;
  }
  return out;
}

function csvCell(value: string): string {
  const flat = value.replace(/\r?\n/g, " ").trim();
  if (/[",]/.test(flat)) return `"${flat.replace(/"/g, "\"\"")}"`;
  return flat;
}

export function xlsxSheetToCsv(xml: string, shared: readonly string[]): string {
  const rows: string[] = [];
  for (const block of xml.split(/<row\b[^>]*>/i).slice(1)) {
    const end = block.search(/<\/row>/i);
    const inner = end >= 0 ? block.slice(0, end) : block;
    const cells: string[] = [];
    for (const match of inner.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attrs = match[1] ?? "";
      const body = match[2] ?? "";
      const type = /(?:^|\s)t="([^"]+)"/.exec(attrs)?.[1] ?? "";
      let value = "";
      if (type === "s") {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
        value = Number.isInteger(idx) ? (shared[idx] ?? "") : "";
      } else if (type === "inlineStr") {
        value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((item) => decodeXml(item[1] ?? "")).join("");
      } else {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
      }
      cells.push(csvCell(value));
    }
    if (cells.some((cell) => cell)) rows.push(cells.join(","));
    if (rows.join("\n").length >= TEXT_CAP) break;
  }
  return rows.join("\n").slice(0, TEXT_CAP).trim();
}

export function pptxSlideToText(xml: string): string {
  const lines = [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi)]
    .map((match) => decodeXml(match[1] ?? "").replace(/\u0000/g, "").trim())
    .filter(Boolean);
  return lines.join("\n").slice(0, TEXT_CAP).trim();
}

async function loadZip(bytes: Uint8Array): Promise<JSZip> {
  return JSZip.loadAsync(bytes);
}

async function xmlAt(zip: JSZip, name: string): Promise<string | null> {
  const file = zip.file(name);
  if (!file) return null;
  const xml = await file.async("string");
  return xml.slice(0, XML_CAP);
}

function capped(parts: string[]): string {
  return parts.filter(Boolean).join("\n\n").slice(0, TEXT_CAP).trim();
}

export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const zip = await loadZip(bytes);
  const names = Object.keys(zip.files)
    .filter((name) => /^word\/(document|footnotes|endnotes|header\d+|footer\d+)\.xml$/i.test(name))
    .sort((a, b) => Number(b.toLowerCase().endsWith("/document.xml")) - Number(a.toLowerCase().endsWith("/document.xml")) || a.localeCompare(b));
  const parts: string[] = [];
  for (const name of names) {
    const xml = await xmlAt(zip, name);
    if (xml) parts.push(xmlToDocxText(xml));
    if (capped(parts).length >= TEXT_CAP) break;
  }
  return capped(parts);
}

export async function extractXlsxText(bytes: Uint8Array): Promise<string> {
  const zip = await loadZip(bytes);
  const sharedXml = await xmlAt(zip, "xl/sharedStrings.xml");
  const shared = sharedXml ? xlsxSharedStrings(sharedXml) : [];
  const sheets = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => sheetIndex(a) - sheetIndex(b) || a.localeCompare(b));
  const parts: string[] = [];
  for (const name of sheets) {
    const xml = await xmlAt(zip, name);
    if (xml) parts.push(xlsxSheetToCsv(xml, shared));
    if (capped(parts).length >= TEXT_CAP) break;
  }
  return capped(parts);
}

export async function extractPptxText(bytes: Uint8Array): Promise<string> {
  const zip = await loadZip(bytes);
  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => slideIndex(a) - slideIndex(b) || a.localeCompare(b));
  const parts: string[] = [];
  for (const name of slides) {
    const xml = await xmlAt(zip, name);
    if (xml) parts.push(pptxSlideToText(xml));
    if (capped(parts).length >= TEXT_CAP) break;
  }
  return capped(parts);
}

function sheetIndex(name: string): number {
  const n = /sheet(\d+)\.xml/i.exec(name);
  return n ? Number(n[1]) : 0;
}

function slideIndex(name: string): number {
  const n = /slide(\d+)\.xml/i.exec(name);
  return n ? Number(n[1]) : 0;
}
