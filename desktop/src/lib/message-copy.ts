import { parseMessage } from "./markers";

/** Visible text a mobile long-press "복사" should put on the clipboard. */
export function messageCopyText(m: { message?: string; attach?: { name?: string } | null }): string {
  const name = m.attach?.name?.trim();
  if (name) return name;
  const parsed = parseMessage(m.message || "");
  const body = parsed.body.trim();
  if (body) return body;
  if (parsed.quote?.text?.trim()) return parsed.quote.text.trim();
  return (m.message || "").trim();
}

export async function writeClipboard(text: string): Promise<void> {
  if (!text) throw new Error("복사할 내용이 없습니다");
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("클립보드 복사에 실패했습니다. 내용을 직접 옮겨 주세요.");
}
