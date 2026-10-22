export function parseTime(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function timeLabel(s?: string): string {
  const d = parseTime(s);
  if (!d) return "";
  return d.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
}

export function roomTimeLabel(s?: string): string {
  const d = parseTime(s);
  if (!d) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return timeLabel(s);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "어제";
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

export function dayLabel(s?: string): string {
  const d = parseTime(s);
  if (!d) return "";
  return d.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
}

export function sameDay(a?: string, b?: string) {
  const x = parseTime(a), y = parseTime(b);
  return !!x && !!y && x.toDateString() === y.toDateString();
}

export function fileSize(n?: number) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function initials(name: string) {
  const t = name.trim();
  if (!t) return "?";
  return /[가-힣]/.test(t[0]) ? t.slice(0, 1) : t.slice(0, 2).toUpperCase();
}

export function hue(seed: string | number) {
  const s = String(seed);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
