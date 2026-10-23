import { describe, expect, it } from "vitest";
import {
  CHAT_BOT_ALLOWED_URLS, CHAT_BOT_DEFAULT, CHAT_BOT_URLS, chatBotUrl, isChatBotUrl,
} from "../electron/core/chatbot";

describe("chat bot inquiry URLs", () => {
  it("picks the brand URL exactly as the original client", () => {
    expect(chatBotUrl("DO_INSTALL")).toBe("https://bit.ly/GPTcsmasterins");
    expect(chatBotUrl("DO_SOLUTION")).toBe("https://bit.ly/GPTcsmaster");
    expect(chatBotUrl("DO_SAAS")).toBe("https://bit.ly/GPTcsmaster");
  });

  it("is case/whitespace tolerant and falls back to DO_SAAS", () => {
    expect(chatBotUrl(" do_solution ")).toBe("https://bit.ly/GPTcsmaster");
    expect(chatBotUrl("do_install")).toBe("https://bit.ly/GPTcsmasterins");
    expect(chatBotUrl()).toBe(CHAT_BOT_DEFAULT);
    expect(chatBotUrl("UNKNOWN")).toBe("https://bit.ly/GPTcsmaster");
    expect(chatBotUrl(null)).toBe("https://bit.ly/GPTcsmaster");
    expect(CHAT_BOT_URLS.DO_SAAS).toBe("https://bit.ly/GPTcsmaster");
  });

  it("whitelists only the three known URLs", () => {
    expect(CHAT_BOT_ALLOWED_URLS).toContain("https://bit.ly/GPTcsmasterins");
    expect(CHAT_BOT_ALLOWED_URLS).toContain("https://bit.ly/GPTcsmaster");
    expect(isChatBotUrl("https://bit.ly/GPTcsmaster")).toBe(true);
    expect(isChatBotUrl("https://bit.ly/GPTcsmasterins")).toBe(true);
    expect(isChatBotUrl("https://evil.example/GPTcsmaster")).toBe(false);
    expect(isChatBotUrl("javascript:alert(1)")).toBe(false);
    expect(isChatBotUrl(null)).toBe(false);
  });
});
