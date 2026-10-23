import fs from "fs";
import path from "path";
import type { IncomingMessage } from "http";

export type MultipartFile = { name: string; mime?: string; path: string; size: number };
export type MultipartResult = { fields: Record<string, string>; file: MultipartFile | null };

export class MultipartError extends Error {
  constructor(public code: "bad_request" | "payload_too_large", message: string) {
    super(message);
    this.name = "MultipartError";
  }
}

/** Boundary from a multipart/form-data content-type, or null if this is not multipart. */
export function multipartBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const ct = contentType.trim();
  if (!/^multipart\/form-data\b/i.test(ct)) return null;
  const m = /(?:^|;)\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(ct);
  const b = m ? (m[1] ?? m[2]) : "";
  return b || null;
}

function bad(message: string) { return new MultipartError("bad_request", message); }

type Part =
  | { kind: "file"; name: string; mime?: string; path: string; size: number }
  | { kind: "field"; name: string; chunks: Buffer[] }
  | { kind: "skip" };

function parseParams(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /;\s*([^=;\s]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    let v = m[2].trim();
    if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    out[m[1].toLowerCase()] = v;
  }
  return out;
}

function decodeFilenameStar(v: string): string {
  const m = /^([^']*)'[^']*'(.*)$/.exec(v);
  const data = m ? m[2] : v;
  try { return decodeURIComponent(data); } catch { return data; }
}

/** Basename after / or \, control chars stripped, trimmed, capped at 200 characters. */
export function sanitizeFilename(raw: string): string {
  const base = raw.replace(/^.*[\\/]/, "");
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return [...clean].slice(0, 200).join("");
}

/**
 * Minimal streaming multipart/form-data parser. File parts are written straight to
 * opts.dir/file with mode 0600; fields are collected in memory. Rejects (and stops
 * writing) as soon as total request bytes exceed opts.maxBytes.
 */
export function parseMultipart(req: IncomingMessage, opts: { boundary: string; dir: string; maxBytes: number }): Promise<MultipartResult> {
  return new Promise((resolve, reject) => {
    const delim = Buffer.from(`--${opts.boundary}`, "utf8");
    const sep = Buffer.from(`\r\n--${opts.boundary}`, "utf8");
    const fields: Record<string, string> = {};
    let buf = Buffer.alloc(0);
    let total = 0;
    let state: "preamble" | "headers" | "body" | "done" = "preamble";
    let fd: number | null = null;
    let file: MultipartFile | null = null;
    let fileCount = 0;
    let part: Part | null = null;
    let settled = false;

    const closeFd = () => { if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } fd = null; } };
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      closeFd();
      reject(e instanceof Error ? e : bad("invalid multipart body"));
    };

    const startPart = (head: string) => {
      let disp = "";
      let mime = "";
      for (const line of head.split("\r\n")) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const k = line.slice(0, i).trim().toLowerCase();
        const v = line.slice(i + 1).trim();
        if (k === "content-disposition") disp = v;
        else if (k === "content-type") mime = v;
      }
      if (!disp) throw bad("missing content-disposition");
      const p = parseParams(disp);
      const name = p.name;
      if (name === "file") {
        fileCount++;
        if (fileCount > 1) throw bad("exactly one file part allowed");
        const fileName = p["filename*"] != null ? decodeFilenameStar(p["filename*"]) : (p.filename ?? "");
        const filePath = path.join(opts.dir, "file");
        fd = fs.openSync(filePath, "wx", 0o600);
        part = { kind: "file", name: fileName, mime: mime || undefined, path: filePath, size: 0 };
      } else if (name === "room_id" || name === "text") {
        part = { kind: "field", name, chunks: [] };
      } else {
        part = { kind: "skip" };
      }
    };

    const consume = (chunk: Buffer) => {
      if (!chunk.length || !part) return;
      if (part.kind === "file") {
        fs.writeSync(fd!, chunk);
        part.size += chunk.length;
      } else if (part.kind === "field") part.chunks.push(Buffer.from(chunk));
    };

    const finishPart = () => {
      if (!part) return;
      if (part.kind === "field") fields[part.name] = Buffer.concat(part.chunks).toString("utf8");
      else if (part.kind === "file") { closeFd(); file = { name: part.name, mime: part.mime, path: part.path, size: part.size }; }
      part = null;
    };

    const pump = () => {
      for (;;) {
        if (state === "preamble") {
          const i = buf.indexOf(delim);
          if (i < 0) {
            const keep = Math.min(buf.length, delim.length + 3);
            if (buf.length > keep) buf = buf.subarray(buf.length - keep);
            return;
          }
          const p = i + delim.length;
          if (buf.length < p + 2) { buf = buf.subarray(i); return; }
          if (buf[p] === 0x2d && buf[p + 1] === 0x2d) { state = "done"; buf = Buffer.alloc(0); return; }
          if (buf[p] !== 0x0d || buf[p + 1] !== 0x0a) throw bad("malformed multipart preamble");
          buf = buf.subarray(p + 2);
          state = "headers";
          continue;
        }
        if (state === "headers") {
          const i = buf.indexOf("\r\n\r\n");
          if (i < 0) {
            if (buf.length > 64 * 1024) throw bad("multipart headers too large");
            return;
          }
          const head = buf.subarray(0, i).toString("utf8");
          buf = buf.subarray(i + 4);
          startPart(head);
          state = "body";
          continue;
        }
        if (state === "body") {
          if (!part) throw bad("invalid part");
          const i = buf.indexOf(sep);
          if (i < 0) {
            const keep = sep.length - 1;
            const safe = buf.length - keep;
            if (safe > 0) { consume(buf.subarray(0, safe)); buf = buf.subarray(safe); }
            return;
          }
          if (i > 0) consume(buf.subarray(0, i));
          const p = i + sep.length;
          if (buf.length < p + 2) { buf = buf.subarray(i); return; }
          if (buf[p] === 0x2d && buf[p + 1] === 0x2d) {
            buf = buf.subarray(p + 2);
            finishPart();
            state = "done";
            return;
          }
          if (buf[p] !== 0x0d || buf[p + 1] !== 0x0a) throw bad("malformed multipart boundary");
          buf = buf.subarray(p + 2);
          finishPart();
          state = "headers";
          continue;
        }
        return;
      }
    };

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > opts.maxBytes) { fail(new MultipartError("payload_too_large", "request too large")); return; }
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      try { pump(); } catch (e) { fail(e); }
    });
    req.on("end", () => {
      if (settled) return;
      try {
        if (state !== "done") throw bad("incomplete multipart body");
        settled = true;
        closeFd();
        resolve({ fields, file });
      } catch (e) { fail(e); }
    });
    req.on("error", (e) => fail(e));
  });
}
