/**
 * Where "내 봇" opens. 1.1 alpha always uses the local PersonalBotChat
 * (`ubm.personal-bot.v1:*`). It does not open the 유비온봇 DM or the 나 room.
 * Group autonomy and /요약 still use those rooms on their own.
 */
export type PersonalBotRoom = {
  key: string;
  kind?: string | null;
  name?: string | null;
  isSelf?: boolean;
  peerUserId?: number;
};

export type PersonalBotTarget = { kind: "local" };

export function resolvePersonalBot(
  _rooms?: readonly PersonalBotRoom[],
  _botUserSeq?: number,
): PersonalBotTarget {
  return { kind: "local" };
}

/** Offline assistant line. Marked [스텁]; does not call a model. */
export function stubBotReply(userText: string): string {
  const text = userText.replace(/\s+/g, " ").trim();
  if (!text) return "[스텁] 무엇을 도와드릴까요?";
  if (/메일/.test(text)) return "[스텁] 메일 읽기는 아직 연결 전입니다. 찾고 싶은 제목을 한 줄로 남겨 주세요.";
  if (/결재/.test(text)) return "[스텁] 결재 조회는 다음 단계입니다. 문서 제목을 메모해 둘게요.";
  if (/일정|캘린더|회의/.test(text)) return "[스텁] 일정 연동 전입니다. 언제인지 한 줄로 남겨 주세요.";
  const chars = Array.from(text);
  const brief = chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : text;
  return `[스텁] 메모해 두었습니다. “${brief}”`;
}
