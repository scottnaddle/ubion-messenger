import { describe, expect, it, vi } from "vitest";
import {
  editCaps, editEnabled, EDIT_MAX_LENGTH, guardEditReplyTarget, normalizeEditText, normalizeReplyTarget,
  normalizeReplyText, performEdit, performReply,
} from "../electron/core/edit-reply";
import { composeEditText, composeQuoteText } from "../src/lib/markers";

describe("edit caps / flag (UBM_EDIT default ON)", () => {
  it("is enabled by default and off only with UBM_EDIT=0", () => {
    expect(editEnabled(undefined)).toBe(true);
    expect(editEnabled({})).toBe(true);
    expect(editEnabled({ UBM_EDIT: "1" })).toBe(true);
    expect(editEnabled({ UBM_EDIT: "0" })).toBe(false);
  });

  it("surfaces self-only from UBM_SELF_ONLY", () => {
    expect(editCaps({ UBM_SELF_ONLY: "1" })).toEqual({ enabled: true, selfOnly: true });
    expect(editCaps({ UBM_EDIT: "0", UBM_SELF_ONLY: "1" })).toEqual({ enabled: false, selfOnly: true });
  });
});

describe("edit/reply normalization", () => {
  it("validates text", () => {
    expect(normalizeEditText("  수정본  ")).toBe("수정본");
    expect(() => normalizeEditText("   ")).toThrow();
    expect(() => normalizeEditText(1)).toThrow();
    expect(() => normalizeEditText("x".repeat(EDIT_MAX_LENGTH + 1))).toThrow();
    expect(normalizeReplyText("네")).toBe("네");
    expect(() => normalizeReplyText("")).toThrow();
  });

  it("validates the reply target", () => {
    expect(normalizeReplyTarget({ messageId: 3, senderName: "김하늘", text: "안녕" })).toEqual({
      messageId: 3, senderName: "김하늘", text: "안녕",
    });
    expect(() => normalizeReplyTarget({ messageId: 0 })).toThrow();
    expect(() => normalizeReplyTarget({})).toThrow();
  });
});

describe("self-only guard reuse", () => {
  const selfRoom = { kind: "room" as const, seq: 99, buddyRoomSeq: undefined };
  const otherRoom = { kind: "room" as const, seq: 7, buddyRoomSeq: undefined };
  const buddySelf = { kind: "buddy" as const, seq: 5, buddyRoomSeq: 99 };

  it("allows the self room and blocks others in safe mode", () => {
    expect(() => guardEditReplyTarget({ selfOnly: true, me: 5, selfRoomSeq: 99, room: selfRoom })).not.toThrow();
    expect(() => guardEditReplyTarget({ selfOnly: true, me: 5, selfRoomSeq: 99, room: otherRoom })).toThrow();
    expect(() => guardEditReplyTarget({ selfOnly: true, me: 5, selfRoomSeq: 99, room: buddySelf })).not.toThrow();
  });

  it("does nothing when self-only is off and throws on a missing room", () => {
    expect(() => guardEditReplyTarget({ selfOnly: false, me: 5, selfRoomSeq: 99, room: otherRoom })).not.toThrow();
    expect(() => guardEditReplyTarget({ selfOnly: true, me: 5, selfRoomSeq: 99, room: null })).toThrow();
  });
});

describe("performEdit (delete then resend)", () => {
  const deps = () => ({
    guard: vi.fn(),
    deleteByIds: vi.fn().mockResolvedValue({ ok: true as const, count: 1 }),
    sendText: vi.fn().mockResolvedValue({ messageId: 999 }),
  });

  it("guards, deletes the original, then resends the edited text in order", async () => {
    const d = deps();
    const order: string[] = [];
    d.guard.mockImplementation(() => order.push("guard"));
    d.deleteByIds.mockImplementation(async () => { order.push("delete"); return { ok: true, count: 1 }; });
    d.sendText.mockImplementation(async () => { order.push("send"); return { messageId: 999 }; });

    const res = await performEdit({ ...d, roomKey: "room:1", origMessageId: 42, newText: "수정본" });

    expect(res).toEqual({ ok: true, messageId: 999 });
    expect(order).toEqual(["guard", "delete", "send"]);
    expect(d.deleteByIds).toHaveBeenCalledWith([42]);
    expect(d.sendText).toHaveBeenCalledWith("room:1", composeEditText("수정본", 42));
  });

  it("does not resend when the delete fails", async () => {
    const d = deps();
    d.deleteByIds.mockRejectedValue(new Error("삭제 실패"));
    await expect(performEdit({ ...d, roomKey: "room:1", origMessageId: 1, newText: "x" })).rejects.toThrow("삭제 실패");
    expect(d.sendText).not.toHaveBeenCalled();
  });

  it("surfaces a send failure after a successful delete", async () => {
    const d = deps();
    d.sendText.mockRejectedValue(new Error("전송 실패"));
    await expect(performEdit({ ...d, roomKey: "room:1", origMessageId: 1, newText: "x" })).rejects.toThrow("전송 실패");
    expect(d.deleteByIds).toHaveBeenCalledTimes(1);
  });

  it("throws the guard error before deleting or sending", async () => {
    const d = deps();
    d.guard.mockImplementation(() => { throw new Error("안전 모드에서는 나에게만 전달할 수 있습니다"); });
    await expect(performEdit({ ...d, roomKey: "room:1", origMessageId: 1, newText: "x" })).rejects.toThrow();
    expect(d.deleteByIds).not.toHaveBeenCalled();
    expect(d.sendText).not.toHaveBeenCalled();
  });
});

describe("performReply (quote + marker)", () => {
  it("guards then sends the composed quote text", async () => {
    const guard = vi.fn();
    const sendText = vi.fn().mockResolvedValue({ messageId: 12 });
    const target = { messageId: 9, senderName: "김하늘", text: "긴 원문입니다" };
    const res = await performReply({ guard, sendText, roomKey: "room:2", target, replyText: "네" });

    expect(res).toEqual({ ok: true, messageId: 12 });
    expect(guard).toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith("room:2", composeQuoteText("김하늘", "긴 원문입니다", "네", 9));
  });
});
