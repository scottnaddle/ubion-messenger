import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import {
  createPersonalBotClient,
  loadPersonalBotTurns,
  PERSONAL_BOT_GREETING,
  PERSONAL_BOT_LIVE_BAD,
  PERSONAL_BOT_LIVE_ERROR,
  PERSONAL_BOT_SERVER_ERROR,
  PERSONAL_BOT_SYSTEM_PROMPT,
  requestPersonalBotReply,
  resolvePersonalBot,
  resolvePersonalBotUrl,
  savePersonalBotTurns,
  stubBotReply,
  toPersonalBotWire,
  UBM_PERSONAL_BOT_URL,
  type PersonalBotStorage,
} from "../src/lib/personal-bot";

const self = { key: "buddy:7", kind: "buddy", name: "나", isSelf: true, peerUserId: 7 };
const bot = { key: "buddy:99", kind: "buddy", name: "유비온봇", isSelf: false, peerUserId: 99 };
const team = { key: "room:5", kind: "room", name: "팀", isSelf: false };

function memory(): PersonalBotStorage & { dump: () => Map<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    dump: () => map,
  };
}

describe("personal bot entry", () => {
  it("always opens the local assistant, not the 유비온봇 DM or the self room", () => {
    expect(resolvePersonalBot([team, self, bot], 99)).toEqual({ kind: "local" });
    expect(resolvePersonalBot([team, self, bot], 0)).toEqual({ kind: "local" });
    expect(resolvePersonalBot([self, team], 99)).toEqual({ kind: "local" });
    expect(resolvePersonalBot([], undefined)).toEqual({ kind: "local" });
  });

  it("keeps a separate transcript per user and drops a stub-only log", () => {
    const store = memory();
    savePersonalBotTurns(store, 7, [
      { id: "greet", role: "bot", text: "[스텁] 안녕하세요. 저는 유비온 비서입니다." },
      { id: "u1", role: "user", text: "안녕" },
      { id: "b1", role: "bot", text: "[스텁] 메모해 두었습니다. “안녕”" },
    ]);
    savePersonalBotTurns(store, 8, [{ id: "u1", role: "user", text: "8번만의 메모" }]);
    expect(loadPersonalBotTurns(store, 7)).toEqual([{ id: "greet", role: "bot", text: PERSONAL_BOT_GREETING }]);
    expect(loadPersonalBotTurns(store, 8).map((t) => t.text)).toEqual(["8번만의 메모"]);
    expect(loadPersonalBotTurns(store, 9)[0].text).toBe(PERSONAL_BOT_GREETING);
    expect([...store.dump().keys()].some((k) => k.includes("buddy"))).toBe(false);
  });

  it("sends user and assistant turns and skips the greeting and stub echoes", () => {
    expect(toPersonalBotWire([
      { id: "greet", role: "bot", text: PERSONAL_BOT_GREETING },
      { id: "u1", role: "user", text: "오늘 일정 있어?" },
      { id: "b1", role: "bot", text: "[스텁] 메모해 두었습니다." },
      { id: "b2", role: "bot", text: "일정은 아직 연결 전입니다." },
    ])).toEqual([
      { role: "user", content: "오늘 일정 있어?" },
      { role: "assistant", content: "일정은 아직 연결 전입니다." },
    ]);
  });

  it("resolves the live proxy unless a stub flag or vitest is set", () => {
    expect(UBM_PERSONAL_BOT_URL).toBe("http://127.0.0.1:8787/v1/personal-bot/chat");
    expect(resolvePersonalBotUrl({})).toBe(UBM_PERSONAL_BOT_URL);
    expect(resolvePersonalBotUrl({ VITE_UBM_PERSONAL_BOT_URL: "http://127.0.0.1:9/v1/personal-bot/chat" }))
      .toBe("http://127.0.0.1:9/v1/personal-bot/chat");
    expect(resolvePersonalBotUrl({ VITE_UBM_PERSONAL_BOT_STUB: "1" })).toBeNull();
    expect(resolvePersonalBotUrl({ VITE_UBM_ROOM_AI_STUB: "1" })).toBeNull();
    expect(resolvePersonalBotUrl({ VITEST: true })).toBeNull();
  });

  it("posts the personal-bot contract and does not attach a key or system prompt", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ reply: "일정은 아직 연결 전입니다. 시간만 말씀해 주세요." }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const reply = await requestPersonalBotReply({
      userId: 7,
      messages: [{ role: "user", content: "오늘 일정 있어?" }],
      fetchImpl,
    });
    expect(reply).toBe("일정은 아직 연결 전입니다. 시간만 말씀해 주세요.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(UBM_PERSONAL_BOT_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({
      userId: 7,
      messages: [{ role: "user", content: "오늘 일정 있어?" }],
    });
    expect(String(init.body)).not.toContain("system");
    expect(JSON.stringify(init.headers).toLowerCase()).not.toContain("authorization");
  });

  it("shows a Korean error and does not invent a stub reply", async () => {
    const down = vi.fn(async () => { throw new Error("network"); });
    await expect(requestPersonalBotReply({
      userId: 7,
      messages: [{ role: "user", content: "안녕" }],
      fetchImpl: down,
    })).rejects.toThrow(PERSONAL_BOT_LIVE_ERROR);

    const server = vi.fn(async () => new Response("nope", { status: 503 }));
    await expect(requestPersonalBotReply({
      userId: 7,
      messages: [{ role: "user", content: "안녕" }],
      fetchImpl: server,
    })).rejects.toThrow(PERSONAL_BOT_SERVER_ERROR);

    const bad = vi.fn(async () => new Response(JSON.stringify({ reply: "" }), { status: 200 }));
    await expect(requestPersonalBotReply({
      userId: 7,
      messages: [{ role: "user", content: "안녕" }],
      fetchImpl: bad,
    })).rejects.toThrow(PERSONAL_BOT_LIVE_BAD);
  });

  it("uses the stub client only when the URL resolves to null", async () => {
    const fetchImpl = vi.fn();
    const stub = createPersonalBotClient({ VITE_UBM_PERSONAL_BOT_STUB: "1" }, fetchImpl);
    const text = await stub.reply({ userId: 7, messages: [{ role: "user", content: "결재 문서 봐줘" }] });
    expect(stub.mode).toBe("stub");
    expect(text).toContain("[스텁]");
    expect(text).toContain("결재");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stubBotReply("안녕하세요")).toBe(stubBotReply("안녕하세요"));
  });

  it("documents the proxy prompt and route for the Mac mini server", () => {
    const note = readFileSync(fileURLToPath(new URL("../docs/personal-bot-proxy.md", import.meta.url)), "utf8");
    expect(note).toContain(PERSONAL_BOT_SYSTEM_PROMPT);
    expect(note).toContain("POST http://127.0.0.1:8787/v1/personal-bot/chat");
    expect(note).toContain("MiniMax-M3.1-Flash");
    expect(note).toContain('"reply"');
    expect(PERSONAL_BOT_SYSTEM_PROMPT).toContain("메모해 두었습니다");
    expect(PERSONAL_BOT_SYSTEM_PROMPT).not.toContain("[스텁]");
  });
});
