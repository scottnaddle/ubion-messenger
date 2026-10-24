/**
 * ubion-media responses for chat files. Sniffs a video type when Daou sends
 * application/octet-stream, and honors a single Range so <video controls> can scrub.
 */

export function sniffMediaType(data: Uint8Array, contentType: string): string {
  const raw = (contentType || "").split(";")[0].trim().toLowerCase();
  if (raw.startsWith("video/") || raw.startsWith("image/") || raw.startsWith("audio/")) return raw || contentType;
  if (raw && raw !== "application/octet-stream" && raw !== "binary/octet-stream") return contentType;
  if (data.length >= 12 && latin1(data, 4, 8) === "ftyp") return "video/mp4";
  if (data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return "video/webm";
  if (data.length >= 12 && latin1(data, 0, 4) === "RIFF" && latin1(data, 8, 12) === "AVI ") return "video/x-msvideo";
  return raw || "application/octet-stream";
}

function latin1(data: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) out += String.fromCharCode(data[i]);
  return out;
}

export type MediaBody = { status: number; headers: Record<string, string>; body: Uint8Array };

/** `rangeHeader` is the raw Range value, e.g. "bytes=0-1023". */
export function buildMediaResponse(data: Uint8Array, contentType: string, rangeHeader: string | null): MediaBody {
  const type = sniffMediaType(data, contentType);
  const size = data.length;
  const headers: Record<string, string> = {
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "max-age=86400",
  };
  const unsatisfiable = (): MediaBody => ({
    status: 416,
    headers: { ...headers, "content-range": `bytes */${size}` },
    body: new Uint8Array(),
  });
  if (!rangeHeader || !rangeHeader.trim()) {
    return { status: 200, headers: { ...headers, "content-length": String(size) }, body: data };
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match || size === 0 || (match[1] === "" && match[2] === "")) return unsatisfiable();
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return unsatisfiable();
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return unsatisfiable();
  }
  if (start < 0 || start >= size || end < start) return unsatisfiable();
  end = Math.min(end, size - 1);
  const body = data.subarray(start, end + 1);
  return {
    status: 206,
    headers: {
      ...headers,
      "content-length": String(body.length),
      "content-range": `bytes ${start}-${end}/${size}`,
    },
    body,
  };
}
