import { isSendEnter, shouldIgnoreEnterForSend } from "./composer";
import { dedupeByMessageId, upsertMessage, canonMessageId } from "./messages";
import type { Message } from "../types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(canonMessageId("18116599") === 18116599, "canon string id");
assert(canonMessageId(18116599) === 18116599, "canon number id");

assert(!isSendEnter({ key: "Enter", shiftKey: false, isComposing: true, keyCode: 229 }), "IME");
assert(shouldIgnoreEnterForSend({ key: "Enter", shiftKey: false, keyCode: 229 }), "229");
assert(isSendEnter({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 }), "send");

// Captured bug: REST number id + XMPP string id must not duplicate
let list: Message[] = [
  {
    messageId: 18116599,
    message: "테스트입니다.",
    sendUserSeq: 312,
    sendUserName: "유인식",
    userImage: "",
    createdAt: "2026-10-22T09:10:34.041+09:00",
  },
];
list = upsertMessage(list, {
  messageId: "18116599" as unknown as number,
  message: "테스트입니다.",
  sendUserSeq: 312,
  sendUserName: "유인식",
  userImage: "",
  // echo missing timestamp (live XMPP)
});
assert(list.length === 1, "string/number id deduped");
assert(list[0].createdAt === "2026-10-22T09:10:34.041+09:00", "kept history timestamp");

// Optimistic + string echo
list = [
  {
    clientId: "c1",
    message: "테스트입니다.",
    sendUserSeq: 312,
    sendUserName: "나",
    userImage: "",
    createdAt: new Date().toISOString(),
    pending: true,
  },
];
list = upsertMessage(list, {
  messageId: "18116599" as unknown as number,
  message: "테스트입니다.",
  sendUserSeq: 312,
  sendUserName: "유인식",
  userImage: "",
});
assert(list.length === 1, "pending reconciled with string id");
assert(list[0].messageId === 18116599, "id numeric");
assert(list[0].pending === false, "not pending");
assert(!!list[0].createdAt, "has timestamp");

// History: two DELETEDMESSAGE with different ids stay (two real deletes)
list = [
  {
    messageId: 18116522,
    message: "사용자가 삭제한 대화입니다.",
    sendUserSeq: 312,
    sendUserName: "유인식",
    userImage: "",
    createdAt: "2026-10-22T09:04:29.572+09:00",
    messageType: "DELETEDMESSAGE",
  },
  {
    messageId: 18116523,
    message: "사용자가 삭제한 대화입니다.",
    sendUserSeq: 312,
    sendUserName: "유인식",
    userImage: "",
    createdAt: "2026-10-22T09:04:31.784+09:00",
    messageType: "DELETEDMESSAGE",
  },
];
assert(dedupeByMessageId(list).length === 2, "two distinct deleted msgs kept");

console.log("composer.test.ts OK");
