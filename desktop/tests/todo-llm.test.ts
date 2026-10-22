import { describe, it, expect, vi } from "vitest";
import { maskForLlm, parseVerdicts, DeepSeekClient, LlmQueue, inBand, finalizeDue, buildRequest, type FetchLike } from "../electron/core/todo/llm";

const okJson = (j: any) => ({ ok: true, status: 200, json: async () => j });

describe("DeepSeek assist (mocked HTTP)", () => {
  it("band is 0.5–0.85 only", () => {
    expect([inBand(0.49), inBand(0.5), inBand(0.7), inBand(0.85), inBand(0.95)]).toEqual([false, true, true, false, false]);
  });
  it("masks names, phones, emails, zoom passcodes/ids, urls, tokens", () => {
    const m = maskForLlm(
      "김민수 과장님 010-1234-5678 a.b@ubion.co.kr 회의 https://zoom.us/j/123?pwd=abc ID 123 456 7890 비밀번호: 9x8y 토큰 abcdefghijklmnopqrstuvwxyz123 내일까지 부탁",
      ["김민수"],
    );
    for (const leak of ["김민수", "1234-5678", "ubion.co.kr", "zoom.us", "9x8y", "123 456 7890", "abcdefghijklmnop"]) expect(m).not.toContain(leak);
    expect(m).toContain("과장님");
    expect(m).toContain("내일까지 부탁");
    expect(maskForLlm("이영희님 확인 부탁")).toBe("<NAME>님 확인 부탁");
  });
  it("strict JSON parsing; bad output → null", () => {
    expect(parseVerdicts("not json", 1)).toBeNull();
    expect(parseVerdicts('{"x":1}', 1)).toBeNull();
    const v = parseVerdicts('{"items":[{"idx":0,"isTask":true,"title":"보고서 <NAME> 제출","confidence":1.4,"dueText":"금요일까지"},{"idx":9,"isTask":true}]}', 1)!;
    expect(v).toHaveLength(1);
    expect(v[0].title).toBe("보고서 제출");
    expect(v[0].confidence).toBe(1);
  });
  it("rules finalize dates; unparseable dueText ignored", () => {
    const anchor = "2026-10-21T10:00:00+09:00";
    expect(finalizeDue("금요일까지", anchor)).toMatch(/^2026-10-23/);
    expect(finalizeDue("언젠가", anchor)).toBeUndefined();
  });
  it("request uses JSON response_format and configured model", () => {
    const r = buildRequest("deepseek-chat", ["a"]);
    expect(r.model).toBe("deepseek-chat");
    expect(r.response_format).toEqual({ type: "json_object" });
  });
  it("calls chat/completions with bearer key", async () => {
    const f = vi.fn<FetchLike>(async () => okJson({ choices: [{ message: { content: '{"items":[{"idx":0,"isTask":true,"title":"자료 공유","confidence":0.9,"dueText":""}]}' } }] }));
    const c = new DeepSeekClient({ baseUrl: "https://api.deepseek.com/", model: "deepseek-chat", getKey: () => "sk-test", fetch: f });
    const v = await c.classify(["자료 공유 부탁"]);
    expect(v?.[0].isTask).toBe(true);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init.headers.authorization).toBe("Bearer sk-test");
  });
  it("timeout / HTTP error → null (rule-only fallback)", async () => {
    const hang: FetchLike = (_u, init) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" }))));
    const c = new DeepSeekClient({ baseUrl: "x", model: "m", getKey: () => "sk-1", fetch: hang, timeoutMs: 20 });
    expect(await c.classify(["x"])).toBeNull();
    const c2 = new DeepSeekClient({ baseUrl: "x", model: "m", getKey: () => "sk-1", fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
    expect(await c2.classify(["x"])).toBeNull();
    expect((await c2.test()).ok).toBe(false);
  });
  it("no key → nothing sent", async () => {
    const f = vi.fn<FetchLike>();
    const c = new DeepSeekClient({ baseUrl: "x", model: "m", getKey: () => undefined, fetch: f });
    expect(await c.classify(["x"])).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it("connection test GETs /models and masks key in errors", async () => {
    const c = new DeepSeekClient({ baseUrl: "https://api.deepseek.com", model: "deepseek-chat", getKey: () => "sk-abc", fetch: async () => okJson({ data: [{ id: "deepseek-chat" }] }) });
    expect(await c.test()).toMatchObject({ ok: true, message: "연결됨" });
    const bad = new DeepSeekClient({ baseUrl: "x", model: "m", getKey: () => "sk-abc", fetch: async () => { throw new Error("fail sk-abc123"); } });
    expect((await bad.test()).message).not.toContain("sk-abc123");
  });
  it("queue batches, masks, and rate-limits", async () => {
    const classify = vi.fn(async (m: string[]) => m.map((_, idx) => ({ idx, isTask: true, confidence: 0.9 })));
    let t = 0;
    const q = new LlmQueue(classify, { batch: 2, perMinute: 1, maxQueue: 3, delayMs: 1e9 }, () => t);
    const got: any[] = [];
    for (let i = 0; i < 4; i++) q.push({ id: String(i), text: "홍길동 부탁 " + i, names: ["홍길동"], anchorIso: "", done: (v) => got.push([i, v]) });
    expect(got).toEqual([[3, null]]);
    await q.flush();
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0][0]).toEqual(["<NAME> 부탁 0", "<NAME> 부탁 1"]);
    await q.flush();
    expect(classify).toHaveBeenCalledTimes(1);
    t = 61_000;
    await q.flush();
    expect(classify).toHaveBeenCalledTimes(2);
    expect(got.filter(([, v]) => v).length).toBe(3);
  });
});
