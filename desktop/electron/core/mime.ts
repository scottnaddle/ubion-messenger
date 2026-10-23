import path from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  txt: "text/plain",
  zip: "application/zip",
};

export function guessMime(p: string): string {
  const ext = path.extname(String(p)).toLowerCase().slice(1);
  return MIME_BY_EXT[ext] || "application/octet-stream";
}
