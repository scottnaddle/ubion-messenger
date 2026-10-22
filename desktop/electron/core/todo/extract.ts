/**
 * Rule-based Korean chat todo / meeting / completion extractor.
 * LLM fallback is a hook only (caller decides; default OFF).
 */
import type { ExtractResult, TodoType } from "./types";
import { normalizeKoreanDate } from "./dates-ko";
import { parseZoom } from "./zoom";

const REQUEST =
  /부탁(드립니다|해요|드려요)?|해\s*주(세요|시겠어요|실\s*수)|해줘|가능할까요|될지요|검토\s*(부탁|요청)|확인\s*(부탁|요청)|회신\s*주세요|공유\s*바랍니다|올려\s*주세요|제출|결재|자료\s*(부탁|요청|공유)/;
const SELF_PROMISE = /할게요|드릴게요|하겠습니다|가겠습니다|보내겠습니다|처리하겠습니다|확인하겠습니다/;
const COMPLETION =
  /완료(했습니다|됐습니다|하였습니다)?|처리했|보냈습니다|전환하였습니다|반영했|끝났|처리\s*완료|완료했어요/;
const ACCEPT = /^(네|넵|네네|예)[~.!\s,]*(알겠습니다|알겠어요|확인했습니다|확인요|오키|오키요|ok|okay)?[~!.\s]*$/i;
const MEETING = /회의|미팅|콜\b|줌|zoom|찾아뵙|면담|일정\s*잡/;
const DEADLINE = /까지|마감|데드라인|EOD|ASAP|오늘\s*중|금일\s*중|늦어도/;
const EXCLUDE = /^(\[광고\]|안녕하세요|안녕하십니까|수고|감사합니다|이모티콘)/;
const EMOJI_ONLY = /^[\p{Emoji}\s~!.]+$/u;

export type ExtractContext = {
  text: string;
  createdAt?: string;
  isMine: boolean;
  roomKind: "buddy" | "room" | "pubsub" | "unknown";
  senderName: string;
  senderSeq?: number;
  mySeq?: number;
  /** Prior messages in room (newest last), for accept-reply / context */
  prior?: Array<{ text: string; isMine: boolean; senderName: string; createdAt?: string }>;
};

function scoreSignals(text: string): { score: number; type: TodoType; isRequest: boolean; isSelfPromise: boolean; isCompletion: boolean; isMeeting: boolean } {
  let score = 0;
  const isRequest = REQUEST.test(text) || DEADLINE.test(text);
  const isSelfPromise = SELF_PROMISE.test(text);
  const isCompletion = COMPLETION.test(text);
  const isMeeting = MEETING.test(text) || /zoom\.us|zoommtg/i.test(text);
  if (isRequest) score += 0.45;
  if (isSelfPromise) score += 0.4;
  if (DEADLINE.test(text)) score += 0.25;
  if (isMeeting) score += 0.35;
  if (isCompletion) score += 0.5;
  if (/보고서?|제출|결재/.test(text)) score += 0.15;
  return { score: Math.min(1, score), type: isMeeting ? "meeting" : isCompletion ? "todo" : "todo", isRequest, isSelfPromise, isCompletion, isMeeting };
}

function titleFrom(text: string, type: TodoType): string {
  let t = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  t = t.replace(/^(네|넵|알겠습니다)[~!.\s]*/i, "").trim();
  if (type === "meeting") {
    const m = t.match(/(.{2,40}?(?:회의|미팅|콜))/);
    if (m) return m[1].trim();
  }
  // strip honorific openers
  t = t.replace(/^[^\s]{2,12}(님|께서|부사장님|과장님|팀장님)\s*/, "");
  if (t.length > 80) t = t.slice(0, 77) + "…";
  return t || "할 일";
}

/**
 * Extract a candidate todo/meeting/completion from one message (+ light context).
 */
export function extractFromMessage(ctx: ExtractContext): ExtractResult | null {
  const raw = (ctx.text || "").trim();
  if (!raw || raw.length < 2) return null;
  if (EMOJI_ONLY.test(raw)) return null;
  if (EXCLUDE.test(raw) && !REQUEST.test(raw) && !MEETING.test(raw) && !DEADLINE.test(raw)) return null;

  const zoom = parseZoom(raw, ctx.createdAt);
  const signals = scoreSignals(raw);
  const isAcceptReply = ACCEPT.test(raw);

  // Accept reply: look at prior messages for a request
  if (isAcceptReply && ctx.isMine && ctx.prior?.length) {
    const prev = [...ctx.prior].reverse().find((p) => !p.isMine && (REQUEST.test(p.text) || DEADLINE.test(p.text) || SELF_PROMISE.test(p.text) === false && MEETING.test(p.text)));
    const prevReq = [...ctx.prior].reverse().find((p) => !p.isMine && (REQUEST.test(p.text) || DEADLINE.test(p.text)));
    if (prevReq) {
      const due = normalizeKoreanDate(prevReq.text, prevReq.createdAt || ctx.createdAt || new Date());
      return {
        title: titleFrom(prevReq.text, "todo"),
        type: MEETING.test(prevReq.text) ? "meeting" : "todo",
        score: 0.88,
        due: due || undefined,
        isCompletion: false,
        isAcceptReply: true,
        isSelfPromise: false,
        isRequest: false,
        evidence: prevReq.text.slice(0, 160),
      };
    }
    if (prev) {
      /* fallthrough */
    }
  }

  if (zoom && zoom.confidence >= 0.7) {
    const due = zoom.startIso
      ? { iso: zoom.startIso, precision: "time" as const, role: "start" as const, confidence: zoom.confidence, matched: "zoom" }
      : normalizeKoreanDate(raw, ctx.createdAt || new Date()) || undefined;
    return {
      title: zoom.title || titleFrom(raw, "meeting"),
      type: "meeting",
      score: Math.max(0.9, zoom.confidence),
      due: due && due.role !== "due" ? undefined : due,
      start: due && due.role !== "due" ? due : zoom.startIso ? { iso: zoom.startIso, precision: "time", role: "start", confidence: 0.9, matched: "zoom" } : due,
      isCompletion: false,
      isAcceptReply: false,
      isSelfPromise: false,
      isRequest: false,
      zoom,
      evidence: raw.slice(0, 160),
    };
  }

  if (signals.score < 0.2 && !isAcceptReply) return null;

  const due = normalizeKoreanDate(raw, ctx.createdAt || new Date()) || undefined;
  let score = signals.score;
  if (due) score = Math.min(1, score + 0.15 * due.confidence);

  // Self promise by me → my todo
  if (signals.isSelfPromise && ctx.isMine) score = Math.min(1, score + 0.1);
  // Request to me in 1:1
  if (signals.isRequest && !ctx.isMine && ctx.roomKind === "buddy") score = Math.min(1, score + 0.1);

  if (score < 0.2) return null;

  return {
    title: titleFrom(raw, signals.type),
    type: signals.type,
    score,
    due: due && (due.role === "due" || DEADLINE.test(raw) || due.role === "unknown") ? due : due?.role === "due" ? due : DEADLINE.test(raw) ? due : undefined,
    start: due && due.role === "start" ? due : signals.isMeeting && due ? due : undefined,
    isCompletion: signals.isCompletion,
    isAcceptReply,
    isSelfPromise: signals.isSelfPromise,
    isRequest: signals.isRequest,
    evidence: raw.slice(0, 160),
  };
}

/** Simple title normalize for dedupe */
export function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 64);
}

/** Dice coefficient on bigrams — light stand-in for embedding similarity */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;
  const big = (s: string) => {
    const set = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) set.set(s.slice(i, i + 2), (set.get(s.slice(i, i + 2)) || 0) + 1);
    return set;
  };
  const A = big(na);
  const B = big(nb);
  let inter = 0;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) || 0);
  return (2 * inter) / (na.length - 1 + (nb.length - 1));
}
