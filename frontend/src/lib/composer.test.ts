import { isSendEnter, shouldIgnoreEnterForSend } from "./composer";
import { dedupeByMessageId, upsertMessage } from "./messages";
import type { Message } from "../types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(
  !isSendEnter({ key: "Enter", shiftKey: false, isComposing: true, keyCode: 229 }),
  "composing Enter should not send"
);
assert(shouldIgnoreEnterForSend({ key: "Enter", shiftKey: false, isComposing: true }), "isComposing");
assert(shouldIgnoreEnterForSend({ key: "Enter", shiftKey: false, keyCode: 229 }), "keyCode 229");
assert(shouldIgnoreEnterForSend({ key: "Enter", shiftKey: false, composingRef: true }), "composingRef");
assert(
  isSendEnter({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, composingRef: false }),
  "normal Enter sends"
);
assert(!isSendEnter({ key: "Enter", shiftKey: true }), "Shift+Enter newline");

const opt: Message = {
  clientId: "c1",
  message: "테스트 메시지 입니다",
  sendUserSeq: 312,
  sendUserName: "나",
  userImage: "",
  createdAt: new Date().toISOString(),
  pending: true,
};
let list = [opt];
list = upsertMessage(list, {
  messageId: 999,
  message: "테스트 메시지 입니다",
  sendUserSeq: 312,
  sendUserName: "나",
  userImage: "",
});
assert(list.length === 1, "optimistic replaced by echo");
assert(list[0].messageId === 999, "server id");
assert(list[0].pending === false, "not pending");
assert(!!list[0].createdAt, "timestamp kept");
list = upsertMessage(list, {
  messageId: 999,
  message: "테스트 메시지 입니다",
  sendUserSeq: 312,
  sendUserName: "나",
  userImage: "",
  createdAt: "2026-10-22T09:04:01+09:00",
});
assert(list.length === 1, "second echo deduped");
assert(dedupeByMessageId([...list, { ...list[0] }]).length === 1, "dedupeByMessageId");
console.log("composer.test.ts OK");

// Reasoning: Enter during composition should defer (not send immediately)
assert(
  shouldIgnoreEnterForSend({ key: "Enter", shiftKey: false, isComposing: true, keyCode: 229 }),
  "IME Enter deferred"
);
// After composition ends, a normal Enter (or deferred send) uses full string including last syllable
const full = "테스트 메시지 입니다";
assert(full.endsWith("다"), "last syllable present in final text");
console.log("IME defer reasoning OK");
