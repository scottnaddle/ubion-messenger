import { describe, expect, it } from "vitest";
import { resolvePersonalBot, stubBotReply } from "../src/lib/personal-bot";

const self = { key: "buddy:7", kind: "buddy", name: "나", isSelf: true, peerUserId: 7 };
const bot = { key: "buddy:99", kind: "buddy", name: "유비온봇", isSelf: false, peerUserId: 99 };
const team = { key: "room:5", kind: "room", name: "팀", isSelf: false };

describe("personal bot entry", () => {
  it("opens the existing 유비온봇 1:1 before the self room", () => {
    expect(resolvePersonalBot([team, self, bot], 99)).toEqual({ kind: "room", roomKey: "buddy:99", via: "bot-dm" });
    expect(resolvePersonalBot([team, self, bot], 0)).toEqual({ kind: "room", roomKey: "buddy:99", via: "bot-dm" });
  });

  it("asks to open a direct room when the bot user is known but not listed", () => {
    expect(resolvePersonalBot([self, team], 99)).toEqual({ kind: "direct", userId: 99 });
  });

  it("falls back to the self room, then a local chat", () => {
    expect(resolvePersonalBot([team, self], 0)).toEqual({ kind: "room", roomKey: "buddy:7", via: "self" });
    expect(resolvePersonalBot([team], 0)).toEqual({ kind: "local" });
    expect(resolvePersonalBot([], undefined)).toEqual({ kind: "local" });
  });

  it("replies offline without echoing a long transcript", () => {
    expect(stubBotReply("결재 문서 봐줘")).toContain("[스텁]");
    expect(stubBotReply("결재 문서 봐줘")).toContain("결재");
    expect(stubBotReply("안녕하세요")).toBe(stubBotReply("안녕하세요"));
  });
});
