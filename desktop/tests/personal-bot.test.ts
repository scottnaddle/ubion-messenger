import { describe, expect, it } from "vitest";
import { resolvePersonalBot, stubBotReply } from "../src/lib/personal-bot";

const self = { key: "buddy:7", kind: "buddy", name: "나", isSelf: true, peerUserId: 7 };
const bot = { key: "buddy:99", kind: "buddy", name: "유비온봇", isSelf: false, peerUserId: 99 };
const team = { key: "room:5", kind: "room", name: "팀", isSelf: false };

describe("personal bot entry", () => {
  it("always opens the local assistant, not the 유비온봇 DM or the self room", () => {
    expect(resolvePersonalBot([team, self, bot], 99)).toEqual({ kind: "local" });
    expect(resolvePersonalBot([team, self, bot], 0)).toEqual({ kind: "local" });
    expect(resolvePersonalBot([self, team], 99)).toEqual({ kind: "local" });
    expect(resolvePersonalBot([team, self], 0)).toEqual({ kind: "local" });
    expect(resolvePersonalBot([team], 0)).toEqual({ kind: "local" });
    expect(resolvePersonalBot([], undefined)).toEqual({ kind: "local" });
  });

  it("replies offline without echoing a long transcript", () => {
    expect(stubBotReply("결재 문서 봐줘")).toContain("[스텁]");
    expect(stubBotReply("결재 문서 봐줘")).toContain("결재");
    expect(stubBotReply("안녕하세요")).toBe(stubBotReply("안녕하세요"));
  });
});
