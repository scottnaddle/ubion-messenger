import type { TodoItem } from "./types";

function esc(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function toUtcStamp(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** Build a VCALENDAR document from todos that have due/start. Read-only export — no portal write. */
export function todosToIcs(items: TodoItem[], calName = "UBION 할일"): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//UBION Messenger//Todo 1.1//KO",
    `X-WR-CALNAME:${esc(calName)}`,
    "CALSCALE:GREGORIAN",
  ];
  for (const it of items) {
    if (it.status !== "open" && it.status !== "done") continue;
    const start = toUtcStamp(it.start || it.due);
    if (!start) continue;
    const endBase = it.start || it.due;
    const endDate = endBase ? new Date(new Date(endBase).getTime() + 60 * 60 * 1000) : undefined;
    const end = toUtcStamp(endDate?.toISOString());
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${it.id}@ubion-messenger`);
    lines.push(`DTSTAMP:${toUtcStamp(new Date().toISOString())}`);
    lines.push(`DTSTART:${start}`);
    if (end) lines.push(`DTEND:${end}`);
    lines.push(`SUMMARY:${esc(it.title)}`);
    const desc = [it.source?.snippet, it.zoomJoinUrl ? `Zoom: ${it.zoomJoinUrl}` : ""].filter(Boolean).join("\\n");
    if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
    if (it.zoomJoinUrl) lines.push(`URL:${it.zoomJoinUrl}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
