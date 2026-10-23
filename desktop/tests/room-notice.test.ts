import { afterEach, describe, expect, it, vi } from "vitest";
import { DaouClient, HttpError } from "../electron/core/daou-client";
import { MessengerCore } from "../electron/core/messenger";
import {
  isNoticeVisible, normalizeNoticeStatus, noticeStoreKey, noticeText, parseNotice, roomNoticePath,
} from "../electron/core/room-notice";
import type { Room } from "../electron/core/types";

const reply = (text = "", status = 200) =>
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

const rawNotice = {
  companyId: 1,
  createdAt: "2026-10-23T01:02:03.000Z",
  message: "공지 내용",
  messageId: 77,
  sendUserName: "홍길동",
  userImage: "/u.png",
  chatMessageAttachFileModel: { cryptId: "crypt", name: "notice.pdf", size: 1234 },
};

describe("room notice", () => {
  it("builds the exact PUT path", () => {
    expect(roomNoticePath(7, 77, 42)).toBe("/api/chat/notice/7?messageId=77&userSeq=42");
    expect(() => roomNoticePath(0, 77, 42)).toThrow();
    expect(() => roomNoticePath(7, 0, 42)).toThrow();
    expect(() => roomNoticePath(7, 77, "x")).toThrow();
  });

  it("parses noticeMessage tolerantly", () => {
    const n = parseNotice({ noticeMessage: rawNotice });
    expect(n).toMatchObject({
      messageId: 77, message: "공지 내용", sendUserName: "홍길동", userImage: "/u.png", companyId: 1,
      createdAt: "2026-10-23T01:02:03.000Z",
    });
    expect(n?.attach).toMatchObject({ cryptId: "crypt", name: "notice.pdf", size: 1234 });
    expect(parseNotice(rawNotice)?.messageId).toBe(77);
    expect(parseNotice({ noticeMessage: {} })).toBeUndefined();
    expect(parseNotice(null)).toBeUndefined();
    expect(parseNotice({ message: "x", messageId: "8" })?.messageId).toBe(8);
    expect(parseNotice({ deletedType: "DELETEDMESSAGE", messageId: 9, message: "old" })?.deletedType).toBe("DELETEDMESSAGE");
  });

  it("decides banner visibility and local status", () => {
    const n = parseNotice(rawNotice)!;
    expect(isNoticeVisible(n, "normal")).toBe(true);
    expect(isNoticeVisible(n, "summary")).toBe(true);
    expect(isNoticeVisible(n, "folded")).toBe(true);
    expect(isNoticeVisible(n, "closed")).toBe(false);
    expect(isNoticeVisible(n, { status: "closed" })).toBe(false);
    expect(isNoticeVisible(undefined, "normal")).toBe(false);
    expect(isNoticeVisible({ ...n, deletedType: "DELETEDMESSAGE" }, "normal")).toBe(false);
    expect(isNoticeVisible({ ...n, messageType: "DELETEDFILE" }, "normal")).toBe(false);
    expect(normalizeNoticeStatus("folded")).toBe("folded");
    expect(normalizeNoticeStatus({ status: "summary" })).toBe("summary");
    expect(normalizeNoticeStatus("wat")).toBe("normal");
    expect(noticeStoreKey(77)).toBe("notice_77");
    expect(noticeText(n)).toBe("📎 notice.pdf");
    expect(noticeText({ ...n, attach: undefined })).toBe("공지 내용");
  });

  it("PUTs to /api/chat/notice with no body and auth query", async () => {
    const f = vi.fn(async () => reply('{"code":"200"}'));
    vi.stubGlobal("fetch", f);
    await expect(client().registerRoomNotice(7, 77)).resolves.toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://daou.example/api/chat/notice/7?messageId=77&userSeq=42");
    expect(init.method).toBe("PUT");
    expect(init.body).toBeUndefined();
  });

  it("surfaces HTTP and JSON code errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply('{"message":"no"}', 403)));
    const err = await client().registerRoomNotice(7, 77).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);

    vi.stubGlobal("fetch", vi.fn(async () => reply('{"code":"500","message":"권한 없음"}')));
    await expect(client().registerRoomNotice(7, 77)).rejects.toThrow("권한 없음");
  });

  it("normalizes noticeMessage from the room list", () => {
    const c = new DaouClient("https://daou.example");
    c.user = { id: 42, repId: 42, name: "", loginId: "" };
    const room = c.normalizeRoom({ buddySeq: 42, buddyRoomSeq: 777, buddyRoomType: "my", noticeMessage: rawNotice });
    expect(room.notice).toMatchObject({ messageId: 77, message: "공지 내용", sendUserName: "홍길동" });
    expect(room.buddyRoomSeq).toBe(777);
    expect(c.normalizeRoom({ buddySeq: 42 }).notice).toBeUndefined();
  });

  it("realtime notice updates the room but is not emitted as a chat message", () => {
    const core = new MessengerCore("https://example.invalid");
    core.client.user = { id: 42, repId: 42, name: "나", loginId: "me" };
    const room: Room = {
      key: "buddy:42", kind: "buddy", seq: 42, name: "나", preview: "", unread: 0,
      usePin: false, usePush: true, avatar: "", isSelf: true,
    };
    (core as any).rooms.set(room.key, room);
    const messages: any[] = [];
    const notices: any[] = [];
    const rooms: any[] = [];
    core.on("message", (m) => messages.push(m));
    core.on("roomNotice", (n) => notices.push(n));
    core.on("rooms", (r) => rooms.push(r));

    (core as any).onBody({
      type: "message", subtype: "single", from: { userSeq: 42, userName: "나" }, toSeq: 42,
      actiontype: "notice", messageId: 99, message: "새 공지", createdAt: "2026-10-23T02:00:00.000Z",
    });

    expect(messages).toHaveLength(0);
    expect(room.notice).toMatchObject({ messageId: 99, message: "새 공지", sendUserName: "나" });
    expect(room.noticeUpdatedAt).toBe("2026-10-23T02:00:00.000Z");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ roomKey: "buddy:42", notice: { messageId: 99 } });
    expect(rooms.length).toBeGreaterThan(0);
    core.shutdown();
  });
});
