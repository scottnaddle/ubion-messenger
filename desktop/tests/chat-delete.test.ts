import { afterEach, describe, expect, it, vi } from "vitest";
import { DaouClient, HttpError, normalizeRestMessage } from "../electron/core/daou-client";
import {
  applyChatDelete, buildChatDeleteBody, canDeleteMessage, chatDeleteBody, CHAT_DELETE_CONFIRM,
  isDeletedMessage, normalizeChatDeleteIds, parseIsMessageDeletable,
} from "../electron/core/chat-delete";
import type { ChatMessage } from "../electron/core/types";

const reply = (text: string, status = 200) =>
  new Response(text, { status, headers: { "content-type": "application/json" } });

function client() {
  const c = new DaouClient("https://daou.example");
  c.user = { id: 42, repId: 42, name: "나", loginId: "me", companyId: 1 };
  return c;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat delete (fake network)", () => {
  it("normalizes ids: positive safe integers only, deduped, non-empty", () => {
    expect(normalizeChatDeleteIds([3, 3, "4", 0, -1, 1.5, "x", null])).toEqual([3, 4]);
    expect(() => normalizeChatDeleteIds([])).toThrow("선택");
    expect(() => normalizeChatDeleteIds([0, -1, 1.2, "nope"])).toThrow("선택");
    expect(() => normalizeChatDeleteIds("1")).toThrow();
  });

  it("builds the verified body {ids:[…]}", () => {
    expect(chatDeleteBody([1, 2])).toEqual({ ids: [1, 2] });
    expect(buildChatDeleteBody([2, 2])).toEqual({ ids: [2] });
  });

  it("applyChatDelete marks only matching rows without mutating them", () => {
    const a: ChatMessage = { messageId: 1, sendUserName: "A", message: "one", userImage: "" };
    const b: ChatMessage = { messageId: 2, sendUserName: "B", message: "two", userImage: "" };
    const list = [a, b];
    const out = applyChatDelete(list, [2, 2]);
    expect(out[0]).toBe(a);
    expect(out[1]).toEqual({ ...b, deleted: true });
    expect(isDeletedMessage(out[1])).toBe(true);
    expect(b.deleted).toBeUndefined();
    expect(applyChatDelete(list, [])).toBe(list);
  });

  it("isDeletedMessage tolerates the known tombstone fields", () => {
    expect(isDeletedMessage({ deleted: true })).toBe(true);
    expect(isDeletedMessage({ isDeleted: true })).toBe(true);
    for (const v of ["DELETED", "DELETE", "D", "deleted"]) expect(isDeletedMessage({ status: v })).toBe(true);
    expect(isDeletedMessage({ messageStatus: "DELETE" })).toBe(true);
    expect(isDeletedMessage({ messageType: "DELETED" })).toBe(true);
    expect(isDeletedMessage({ type: "deleted" })).toBe(true);
    expect(isDeletedMessage({ messageType: "TEXT", deleted: false })).toBe(false);
    expect(isDeletedMessage(null)).toBe(false);
  });

  it("server/realtime normalization keeps tombstones", () => {
    const m = normalizeRestMessage({ messageId: 9, messageType: "DELETED", message: "secret" });
    expect(m.deleted).toBe(true);
    expect(isDeletedMessage(m)).toBe(true);
    expect(normalizeRestMessage({ messageId: 10, messageStatus: "D", message: "gone" }).deleted).toBe(true);
    expect(normalizeRestMessage({ messageId: 11, message: "hi" }).deleted).toBeUndefined();
  });

  it("PUTs to /api/chat/message/delete with userSeq, auth headers and JSON ids", async () => {
    const f = vi.fn(async () => reply('{"code":"200","message":"OK"}'));
    vi.stubGlobal("fetch", f);
    const c = client();

    await expect(c.deleteChatMessages([5, 5, "6"])).resolves.toEqual({ ok: true, count: 2 });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://daou.example/api/chat/message/delete?userSeq=42");
    expect(init.method).toBe("PUT");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body.toString())).toEqual({ ids: [5, 6] });
  });

  it("rejects a 200 response whose JSON code != 200 with the server message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply('{"code":"500","message":"권한 없음"}')));
    await expect(client().deleteChatMessages([1])).rejects.toThrow("권한 없음");
  });

  it("rejects HTTP errors as HttpError and never calls fetch for invalid/empty ids", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply('{"code":"403","message":"삭제할 수 없습니다"}', 403)));
    const err = await client().deleteChatMessages([1]).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);

    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(client().deleteChatMessages([])).rejects.toThrow("선택");
    expect(f).not.toHaveBeenCalled();
  });

  it("reads isMessageDeletable from /api/user/session data, including nested config", async () => {
    expect(parseIsMessageDeletable({ isMessageDeletable: false })).toBe(false);
    expect(parseIsMessageDeletable({ config: { isMessageDeletable: false } })).toBe(false);
    expect(parseIsMessageDeletable({ messengerConfig: { isMessageDeletable: "true" } })).toBe(true);
    expect(parseIsMessageDeletable({ config: { messengerConfig: { isMessageDeletable: 0 } } })).toBe(false);
    expect(parseIsMessageDeletable({ id: 1 })).toBeUndefined();

    vi.stubGlobal("fetch", vi.fn(async () => reply(JSON.stringify({
      code: "200",
      data: { id: 42, repId: 42, name: "나", loginId: "me", companyId: 1, config: { isMessageDeletable: false } },
    }))));
    const c = client();
    const u = await c.fetchSession();
    expect(u.isMessageDeletable).toBe(false);
  });

  it("only own, saved, not-yet-deleted messages are deletable; missing flag allows", () => {
    expect(canDeleteMessage({ messageId: 1, sendUserSeq: 1 }, 1)).toBe(true);
    expect(canDeleteMessage({ messageId: 1, sendUserSeq: 2 }, 1)).toBe(false);
    expect(canDeleteMessage({ messageId: 1, sendUserSeq: 1, deleted: true }, 1)).toBe(false);
    expect(canDeleteMessage({ messageId: 1, sendUserSeq: 1, pending: true }, 1)).toBe(false);
    expect(canDeleteMessage({ sendUserSeq: 1 }, 1)).toBe(false);
    expect(CHAT_DELETE_CONFIRM).toBe("해당 메세지의 내용이 삭제된 메세지로 표시됩니다. 정말 삭제하시겠습니까?");
  });
});
