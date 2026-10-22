/**
 * Message → extract → auto-add / suggest. LLM hook is present but OFF unless settings.llmFallback.
 * No server calls from this module.
 */
import type { ChatMessage, RoomKind } from "../types";
import { extractFromMessage, titleSimilarity } from "./extract";
import type { TodoStore } from "./store";
import type { TodoItem, TodoSuggestion } from "./types";

export type PipelineEvent =
  | { type: "auto"; item: TodoItem }
  | { type: "suggest"; suggestion: TodoSuggestion }
  | { type: "complete-suggest"; suggestion: TodoSuggestion };

export type MsgCtx = {
  roomKey: string;
  roomKind: RoomKind;
  isMine: boolean;
  mySeq?: number;
  prior?: ChatMessage[];
};

/**
 * Optional LLM fallback — design hook only. Never called unless explicitly enabled
 * AND a provider is injected. Default: no-op / undefined.
 */
export type LlmExtractFn = (input: {
  text: string;
  prior: string[];
}) => Promise<{ title: string; confidence: number; dueSpan?: string } | null>;

export function processMessage(
  store: TodoStore,
  msg: ChatMessage,
  ctx: MsgCtx,
  _llm?: LlmExtractFn,
): PipelineEvent | null {
  if (!store.isRoomEnabled(ctx.roomKey)) return null;
  if (store.ignoreStreak(ctx.roomKey) >= 3) {
    // still allow high-confidence auto (>=0.9) but skip mid suggestions
  }

  const prior = (ctx.prior || []).slice(-6).map((m) => ({
    text: m.message,
    isMine: !!ctx.mySeq && m.sendUserSeq === ctx.mySeq,
    senderName: m.sendUserName,
    createdAt: m.createdAt,
  }));

  const result = extractFromMessage({
    text: msg.message,
    createdAt: msg.createdAt,
    isMine: ctx.isMine,
    roomKind: ctx.roomKind,
    senderName: msg.sendUserName,
    senderSeq: msg.sendUserSeq,
    mySeq: ctx.mySeq,
    prior,
  });

  // LLM hook: only if enabled and score in band — NOT called by default
  // (intentionally unused unless _llm provided && settings.llmFallback)
  void _llm;

  if (!result) return null;

  if (result.isCompletion) {
    const open = store.list({ status: "open" }).filter((t) => t.roomKey === ctx.roomKey);
    const match = open.find((t) => titleSimilarity(t.title, result.title || "") >= 0.5);
    if (match) {
      const sug = store.addSuggestion({
        kind: "complete",
        draft: { ...match, confidence: result.score },
        evidenceText: result.evidence,
        roomKey: ctx.roomKey,
        messageId: msg.messageId,
      });
      return { type: "complete-suggest", suggestion: sug };
    }
    return null;
  }

  const assigneeSeq = ctx.isMine && result.isSelfPromise ? ctx.mySeq ?? null : !ctx.isMine && ctx.roomKind === "buddy" ? ctx.mySeq ?? null : null;
  const draft = {
    title: result.title || "할 일",
    type: result.type,
    confidence: result.score,
    due: result.due?.iso,
    start: result.start?.iso,
    precision: result.due?.precision || result.start?.precision,
    requesterName: ctx.isMine ? undefined : msg.sendUserName,
    requesterSeq: ctx.isMine ? undefined : msg.sendUserSeq,
    assigneeSeq,
    roomKey: ctx.roomKey,
    source: {
      roomKey: ctx.roomKey,
      messageId: msg.messageId,
      createdAt: msg.createdAt,
      snippet: result.evidence,
    },
    zoomMeetingId: result.zoom?.meetingId,
    zoomJoinUrl: result.zoom?.joinUrl,
  };

  const score = result.score;
  if (score >= 0.85) {
    const item = store.add({
      ...draft,
      status: "open",
      origin: "auto",
      zoomPasscode: result.zoom?.passcode,
    } as any);
    return { type: "auto", item };
  }
  if (score >= 0.5) {
    if (store.ignoreStreak(ctx.roomKey) >= 3) return null;
    const sug = store.addSuggestion({
      kind: "add",
      draft: { ...draft, zoomPasscode: result.zoom?.passcode } as any,
      evidenceText: result.evidence,
      roomKey: ctx.roomKey,
      messageId: msg.messageId,
    });
    return { type: "suggest", suggestion: sug };
  }
  return null;
}
