/**
 * 챗봇 문의 (v1.0.17): service URLs from the original client, selected by brandName.
 * Only these exact URLs may be opened through the IPC bridge.
 */
export const CHAT_BOT_URLS = {
  DO_INSTALL: "https://bit.ly/GPTcsmasterins",
  DO_SOLUTION: "https://bit.ly/GPTcsmaster",
  DO_SAAS: "https://bit.ly/GPTcsmaster",
} as const;

export const CHAT_BOT_DEFAULT = CHAT_BOT_URLS.DO_SAAS;
export const CHAT_BOT_ALLOWED_URLS: readonly string[] = [...new Set(Object.values(CHAT_BOT_URLS))];

/** brandName → chat-bot URL; unknown/empty brands fall back to DO_SAAS. */
export function chatBotUrl(brandName?: unknown): string {
  const key = String(brandName ?? "").trim().toUpperCase();
  return (CHAT_BOT_URLS as Record<string, string>)[key] || CHAT_BOT_DEFAULT;
}

/** True only for the exact whitelisted chat-bot URLs. */
export function isChatBotUrl(url: unknown): boolean {
  return typeof url === "string" && CHAT_BOT_ALLOWED_URLS.includes(url);
}
