/**
 * Where "내 봇" opens. Prefer an existing 유비온봇 1:1, then openDirect when the bot userSeq
 * is known, then the memo-to-self room (the existing command channel), then a local stub chat.
 */
import { BOT_NAMES } from "./bot-room";

export type PersonalBotRoom = {
  key: string;
  kind?: string | null;
  name?: string | null;
  isSelf?: boolean;
  peerUserId?: number;
};

export type PersonalBotTarget =
  | { kind: "room"; roomKey: string; via: "bot-dm" | "self" }
  | { kind: "direct"; userId: number }
  | { kind: "local" };

function isBotName(name?: string | null): boolean {
  const trimmed = (name ?? "").trim();
  return (BOT_NAMES as readonly string[]).includes(trimmed);
}

export function resolvePersonalBot(rooms: readonly PersonalBotRoom[], botUserSeq?: number): PersonalBotTarget {
  const seq = typeof botUserSeq === "number" && Number.isSafeInteger(botUserSeq) && botUserSeq > 0 ? botUserSeq : 0;
  const botDm = rooms.find((room) =>
    room.kind === "buddy" && !room.isSelf && (
      (seq > 0 && room.peerUserId === seq) || isBotName(room.name)
    ),
  );
  if (botDm) return { kind: "room", roomKey: botDm.key, via: "bot-dm" };
  if (seq > 0) return { kind: "direct", userId: seq };
  const self = rooms.find((room) => room.isSelf && room.key);
  if (self) return { kind: "room", roomKey: self.key, via: "self" };
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
