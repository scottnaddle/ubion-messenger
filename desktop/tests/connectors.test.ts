import { describe, expect, it } from "vitest";
import {
  advertisedTools,
  CONNECTORS,
  connectorStatusList,
  loadConnectorPrefs,
  resolveConnectors,
  saveConnectorPrefs,
  type ConnectorPrefs,
} from "../src/lib/connectors";
import { executePersonalBotTool, type UbionToolApi } from "../src/lib/personal-bot-tools";
import { runPersonalBotTools, PERSONAL_BOT_SYSTEM_PROMPT, PERSONAL_BOT_TOOL_ERROR } from "../src/lib/personal-bot";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
  };
}

const ubion: UbionToolApi = {
  mailList: async () => ({
    folder: "Inbox",
    total: 1,
    unread: 1,
    items: [{ uid: 5, subject: "결재 안내", from: { name: "김민수", address: "a@ubion.co.kr" }, dateUtc: "2026-10-24T00:00:00Z", seen: false, preview: "확인해 주세요" }],
  }),
  approvalList: async () => ({ items: [{ id: 9, title: "출장", drafterName: "이서연", draftedAt: "2026-10-24", docStatusName: "진행", emergency: false }] }),
  calendarToday: async () => ({ items: [{ summary: "주간회의", start: "2026-10-24T10:00:00+09:00", end: "2026-10-24T11:00:00+09:00", allDay: false, location: "3층" }] }),
};

describe("connector registry", () => {
  it("advertises company read tools and leaves Google for later", () => {
    const resolved = resolveConnectors({});
    expect(advertisedTools(resolved).map((tool) => tool.name)).toEqual([
      "ubion_mail_list",
      "ubion_approval_list",
      "ubion_calendar_today",
    ]);
    expect(connectorStatusList(resolved).find((item) => item.id === "google-drive")?.state).toBe("connect-later");
    expect(advertisedTools(resolved).some((tool) => tool.name === "ubion_mail_send")).toBe(false);
    expect(CONNECTORS.some((item) => item.id === "ubion-mail" && item.tools.some((tool) => tool.effect === "write"))).toBe(true);
  });

  it("stores a per-user toggle and drops a disabled tool", () => {
    const store = memory();
    saveConnectorPrefs(store, 7, { "ubion-mail": { enabled: false } });
    saveConnectorPrefs(store, 8, {});
    const mine = loadConnectorPrefs(store, 7);
    expect(advertisedTools(resolveConnectors(mine)).map((tool) => tool.name)).not.toContain("ubion_mail_list");
    expect(advertisedTools(resolveConnectors(loadConnectorPrefs(store, 8))).map((tool) => tool.name)).toContain("ubion_mail_list");
  });

  it("reads mail through the session api and gates writes", async () => {
    const resolved = resolveConnectors({});
    const mail = JSON.parse(await executePersonalBotTool(
      { id: "c1", name: "ubion_mail_list", arguments: { limit: 5 } },
      { resolved, ubion },
    ));
    expect(mail.ok).toBe(true);
    expect(mail.items[0].subject).toBe("결재 안내");
    const blocked = JSON.parse(await executePersonalBotTool(
      { id: "c2", name: "ubion_mail_send", arguments: { to: "a@ubion.co.kr", subject: "x", body: "y" } },
      { resolved, ubion },
    ));
    expect(blocked.code).toBe("write-gated");
    const google = JSON.parse(await executePersonalBotTool(
      { id: "c3", name: "google_drive_list", arguments: {} },
      { resolved, ubion },
    ));
    expect(google.code).toBe("connect-later");
  });

  it("runs a plugged Google executor only after a token is stored", async () => {
    const prefs: ConnectorPrefs = { "google-drive": { enabled: true, oauthToken: "token" } };
    const resolved = resolveConnectors(prefs);
    expect(advertisedTools(resolved).map((tool) => tool.name)).toContain("google_drive_list");
    const listed = JSON.parse(await executePersonalBotTool(
      { id: "g1", name: "google_drive_list", arguments: { query: "보고서" } },
      { resolved, extra: { google_drive_list: async () => ({ ok: true, files: ["보고서.pdf"] }) } },
    ));
    expect(listed.files).toEqual(["보고서.pdf"]);
  });

  it("loops tool calls on the desktop and then takes the reply", async () => {
    const calls: unknown[] = [];
    const post = async (input: { messages: { role: string }[]; tools: { name: string }[] }) => {
      calls.push(input);
      if (calls.length === 1) {
        return { reply: "", toolCalls: [{ id: "call_1", name: "ubion_mail_list", arguments: { folder: "Inbox" } }] };
      }
      expect(input.messages.some((message) => message.role === "tool")).toBe(true);
      expect(input.tools.map((tool) => tool.name)).toContain("ubion_mail_list");
      return { reply: "받은편지함에 결재 안내가 있습니다.", toolCalls: [] };
    };
    const result = await runPersonalBotTools({
      userId: 7,
      messages: [{ role: "user", content: "오늘 메일 뭐 왔어?" }],
      tools: advertisedTools(resolveConnectors({})),
      connectorStatus: connectorStatusList(resolveConnectors({})),
      execute: (call) => executePersonalBotTool(call, { resolved: resolveConnectors({}), ubion }),
      post,
    });
    expect(result.reply).toContain("결재 안내");
    expect(result.added.map((message) => message.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(calls).toHaveLength(2);
  });

  it("stops after the tool-step cap", async () => {
    await expect(runPersonalBotTools({
      userId: 7,
      messages: [{ role: "user", content: "메일" }],
      tools: [],
      connectorStatus: [],
      maxSteps: 1,
      execute: async () => "{\"ok\":true}",
      post: async () => ({ reply: "", toolCalls: [{ id: "c", name: "ubion_mail_list", arguments: {} }] }),
    })).rejects.toThrow(PERSONAL_BOT_TOOL_ERROR);
  });

  it("documents the tool contract and the updated prompt", () => {
    const note = readFileSync(fileURLToPath(new URL("../docs/personal-bot-proxy.md", import.meta.url)), "utf8");
    expect(note).toContain(PERSONAL_BOT_SYSTEM_PROMPT);
    expect(note).toContain("toolCalls");
    expect(note).toContain("ubion_mail_list");
    expect(note).toContain("connect-later");
    expect(note).toContain("Daou");
    expect(PERSONAL_BOT_SYSTEM_PROMPT).not.toContain("아직 연결되어 있지 않습니다");
  });
});
