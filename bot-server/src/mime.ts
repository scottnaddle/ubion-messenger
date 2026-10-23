const MIME: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  hwp: "application/x-hwp",
  hwpx: "application/vnd.hancom.hwpx",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Guess an attachment MIME type from its file name; unknown types are octet-stream. */
export function mimeFor(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name ?? ""));
  return (m && MIME[m[1].toLowerCase()]) || "application/octet-stream";
}
