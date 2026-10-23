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

function extension(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name ?? ""));
  return m ? m[1].toLowerCase() : "";
}

async function run(cmd: string, args: string[], timeout = 20_000): Promise<string> {
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

function stripTags(s: string): string {
  return decodeXml(s.replace(/<[^>]*>/g, ""));
}

function unzipList(file: string): Promise<string[]> {
  return run("unzip", ["-Z1", file]).then((out) => out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
}

function unzipEntry(file: string, entry: string): Promise<string> {
  return run("unzip", ["-p", file, entry]);
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

async function extractDocx(file: string): Promise<string> {
  const xml = await unzipEntry(file, "word/document.xml");
  return decodeXml(xml.replace(/<\/w:p\s*>/gi, "\n").replace(/<[^>]*>/g, ""));
}

async function extractPptx(file: string): Promise<string> {
  const entries = (await unzipList(file)).filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e)).sort((a, b) => slideNumber(a) - slideNumber(b));
  const parts: string[] = [];
  for (const entry of entries) {
    const n = slideNumber(entry);
    parts.push(`--- slide ${n} ---`);
    parts.push(stripTags(await unzipEntry(file, entry)).trim());
  }
  return parts.join("\n");
}

async function extractXlsx(file: string): Promise<string> {
  const entries = (await unzipList(file)).filter((e) => /^xl\/sharedStrings\.xml$/i.test(e) || /^xl\/worksheets\/[^/]+\.xml$/i.test(e));
  entries.sort((a, b) => (/(^|\/)sharedStrings\.xml$/i.test(a) ? -1 : 1) - (/(^|\/)sharedStrings\.xml$/i.test(b) ? -1 : 1) || a.localeCompare(b));
  const parts: string[] = [];
  for (const entry of entries) {
    const values = xmlTagValues(await unzipEntry(file, entry));
    if (values.length) parts.push(values.join("\n"));
  }
  return parts.join("\n");
}

async function extractHwpx(file: string): Promise<string> {
  const entries = (await unzipList(file)).filter((e) => /^Contents\/section[^/]*\.xml$/i.test(e));
  entries.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const parts: string[] = [];
  for (const entry of entries) parts.push(stripTags(await unzipEntry(file, entry)).trim());
  return parts.join("\n");
}

/** Extract plain text from an inbound attachment. Unsupported types throw ExtractError(415). */
export async function extractText(name: string, data: Buffer): Promise<ExtractResult> {
  const ext = extension(name);
  const mime = mimeFor(name);
  if (TEXT_EXT.has(ext)) return { text: data.toString("utf8").replace(/^\uFEFF/, ""), mime };
  if (ext === "pdf") {
    return {
      text: await withTempFile(name, data, async (file) => run("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"])),
      mime,
    };
  }
  if (ext === "docx") return { text: await withTempFile(name, data, extractDocx), mime };
  if (ext === "pptx") return { text: await withTempFile(name, data, extractPptx), mime };
  if (ext === "xlsx") return { text: await withTempFile(name, data, extractXlsx), mime };
  if (ext === "hwpx") return { text: await withTempFile(name, data, extractHwpx), mime };
  throw new ExtractError(415, "unsupported_type", `unsupported attachment type: ${ext || "(none)"}`);
}

export const extract = extractText;
