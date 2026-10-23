/**
 * 유비온봇 대화 요약 / 안 읽은 메시지 요약: builds the command string the client posts to the
 * 유비온봇 bot room (the 나 room / memo-to-self). No company message content is sent to any LLM
 * from the client — only the `/요약 <roomKey> [안읽음|오늘|최근N]` command line. Behind UBM_BOT_SUMMARY=1.
 *
 * Pure helpers shared by the renderer and the main process.
 */

export type SummaryMode = "unread" | "today" | "recent";

export const SUMMARY_MODE_LABEL: Record<SummaryMode, string> = {
  unread: "안읽음",
  today: "오늘",
  recent: "최근",
};

export const SUMMARY_MODES: readonly SummaryMode[] = ["unread", "today", "recent"];
export const SUMMARY_DEFAULT_RECENT_N = 20;
export const SUMMARY_MAX_RECENT_N = 1000;

export function normalizeSummaryMode(value: unknown): SummaryMode {
  if (value === "unread" || value === "today" || value === "recent") return value;
  throw new Error("요약 방식을 선택하세요");
}

export function normalizeRecentN(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > SUMMARY_MAX_RECENT_N)
    throw new Error(`최근 메시지 수는 1~${SUMMARY_MAX_RECENT_N} 사이여야 합니다`);
  return n;
}

/** Compose the bot command: "/요약 <roomKey> 안읽음|오늘|최근N". */
export function composeSummaryCommand(roomKey: string, mode: SummaryMode, recentN?: number): string {
  const suffix = mode === "recent" ? `최근${recentN ?? SUMMARY_DEFAULT_RECENT_N}` : SUMMARY_MODE_LABEL[mode];
  return `/요약 ${roomKey} ${suffix}`;
}
