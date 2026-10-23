import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { mimeFor } from "./mime";

const execFileAsync = promisify(execFile);

export class ExtractError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ExtractError";
  }
}

export type ExtractResult = { text: string; mime: string };

const TEXT_EXT = new Set(["txt", "md", "csv", "json", "log"]);
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 300;
const EXTRACT_DEADLINE_MS = 30_000;

function extension(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name ?? ""));
  return m ? m[1].toLowerCase() : "";
}

function clipUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  return Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
}

function deadlineError(): ExtractError {
  return new ExtractError(504, "extract_timeout", "attachment extraction timed out");
}

function checkDeadline(deadline: number): void {
  if (Date.now() >= deadline) throw deadlineError();
}

async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_res, rej) => {
    timer = setTimeout(() => rej(deadlineError()), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function run(cmd: string, args: string[], deadline: number): Promise<string> {
  checkDeadline(deadline);
  const timeout = Math.max(1, Math.min(20_000, deadline - Date.now()));
  const { stdout } = await execFileAsync(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" });
  return String(stdout);
}

async function withTempFile<T>(name: string, data: Buffer, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ubm-extract-"));
  const file = path.join(dir, `input.${extension(name) || "bin"}`);
  try {
    await fs.promises.writeFile(file, data, { mode: 0o600 });
    return await fn(file);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function codePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => codePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Linear single-pass tag stripper (avoids regex backtracking on pathological input). */
export function stripTags(s: string): string {
  const n = s.length;
  let i = 0;
  let start = 0;
  const pieces: string[] = [];
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt < 0) { pieces.push(s.slice(start)); break; }
    pieces.push(s.slice(start, lt));
    const gt = s.indexOf(">", lt + 1);
    if (gt < 0) break;
    i = gt + 1;
    start = i;
  }
  return decodeXml(pieces.join(""));
}

function unzipList(file: string, deadline: number): Promise<string[]> {
  return run("unzip", ["-Z1", file], deadline).then((out) => out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
}

function unzipEntry(file: string, entry: string, deadline: number): Promise<string> {
  if (/[*?\[\]]/.test(entry)) return Promise.reject(new ExtractError(422, "unsafe_entry", "archive entry name contains wildcard characters"));
  return run("unzip", ["-p", file, entry], deadline);
}

function slideNumber(entry: string): number {
  const m = /slide(\d+)\.xml$/i.exec(entry);
  return m ? Number(m[1]) : 0;
}

function xmlTagValues(xml: string, tag = "t"): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(decodeXml(m[1]));
  return out;
}

async function extractDocx(file: string, deadline: number): Promise<string> {
  const xml = clipUtf8(await unzipEntry(file, "word/document.xml", deadline), MAX_XML_BYTES);
  return stripTags(xml.replace(/<\/w:p\s*>/gi, "\n"));
}

async function extractPptx(file: string, deadline: number): Promise<string> {
  const entries = (await unzipList(file, deadline))
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
    .slice(0, MAX_ZIP_ENTRIES);
  const parts: string[] = [];
  for (const entry of entries) {
    checkDeadline(deadline);
    const n = slideNumber(entry);
    parts.push(`--- slide ${n} ---`);
    parts.push(stripTags(clipUtf8(await unzipEntry(file, entry, deadline), MAX_XML_BYTES)).trim());
  }
  return parts.join("\n");
}

async function extractXlsx(file: string, deadline: number): Promise<string> {
  const entries = (await unzipList(file, deadline))
    .filter((e) => /^xl\/sharedStrings\.xml$/i.test(e) || /^xl\/worksheets\/[^/]+\.xml$/i.test(e));
  entries.sort((a, b) => (/(^|\/)sharedStrings\.xml$/i.test(a) ? -1 : 1) - (/(^|\/)sharedStrings\.xml$/i.test(b) ? -1 : 1) || a.localeCompare(b));
  const parts: string[] = [];
  for (const entry of entries.slice(0, MAX_ZIP_ENTRIES)) {
    checkDeadline(deadline);
    const values = xmlTagValues(clipUtf8(await unzipEntry(file, entry, deadline), MAX_XML_BYTES));
    if (values.length) parts.push(values.join("\n"));
  }
  return parts.join("\n");
}

async function extractHwpx(file: string, deadline: number): Promise<string> {
  const entries = (await unzipList(file, deadline))
    .filter((e) => /^Contents\/section[^/]*\.xml$/i.test(e))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, MAX_ZIP_ENTRIES);
  const parts: string[] = [];
  for (const entry of entries) {
    checkDeadline(deadline);
    parts.push(stripTags(clipUtf8(await unzipEntry(file, entry, deadline), MAX_XML_BYTES)).trim());
  }
  return parts.join("\n");
}

async function extractUncapped(name: string, data: Buffer, deadline: number): Promise<ExtractResult> {
  const ext = extension(name);
  const mime = mimeFor(name);
  if (TEXT_EXT.has(ext)) return { text: data.toString("utf8").replace(/^\uFEFF/, ""), mime };
  if (ext === "pdf") {
    return {
      text: await withTempFile(name, data, async (file) => run("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], deadline)),
      mime,
    };
  }
  if (ext === "docx") return { text: await withTempFile(name, data, (file) => extractDocx(file, deadline)), mime };
  if (ext === "pptx") return { text: await withTempFile(name, data, (file) => extractPptx(file, deadline)), mime };
  if (ext === "xlsx") return { text: await withTempFile(name, data, (file) => extractXlsx(file, deadline)), mime };
  if (ext === "hwpx") return { text: await withTempFile(name, data, (file) => extractHwpx(file, deadline)), mime };
  throw new ExtractError(415, "unsupported_type", `unsupported attachment type: ${ext || "(none)"}`);
}

/** Extract plain text from an inbound attachment. Unsupported types throw ExtractError(415). */
export async function extractText(name: string, data: Buffer): Promise<ExtractResult> {
  const deadline = Date.now() + EXTRACT_DEADLINE_MS;
  const result = await withDeadline(extractUncapped(name, data, deadline), EXTRACT_DEADLINE_MS);
  return { text: clipUtf8(result.text, MAX_TEXT_BYTES), mime: result.mime };
}

export const extract = extractText;
