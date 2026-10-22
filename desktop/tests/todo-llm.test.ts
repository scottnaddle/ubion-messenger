import { describe, it, expect, vi } from "vitest";
import { aiConfig, maskForLlm, parseVerdicts, AiClient, LlmQueue, inBand, finalizeDue, buildRequest, type FetchLike } from "../electron/core/todo/llm";

const okJson = (j: any) => ({ ok: true, status: 200, json: async () => j });

describe("Company AI assist via LiteLLM proxy (mocked HTTP)", () => {
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
    const r = buildRequest("ubm-todo", ["a"]);
    expect(r.model).toBe("ubm-todo");
    expect(r.response_format).toEqual({ type: "json_object" });
  });
  it("build-time config: empty url or key → off; model defaults to ubm-todo", () => {
    expect(aiConfig({})).toBeNull();
    expect(aiConfig({ baseUrl: "https://ai.example", key: "" })).toBeNull();
    expect(aiConfig({ baseUrl: "", key: "vk-test" })).toBeNull();
    expect(aiConfig({ baseUrl: "https://ai.example", key: "vk-test" })).toEqual({ baseUrl: "https://ai.example", key: "vk-test", model: "ubm-todo" });
    expect(aiConfig()).toBeNull(); // no define injected in tests
  });
  it("caps batch at 5 and text at 500 chars", async () => {
    const f = vi.fn<FetchLike>(async () => okJson({ choices: [{ message: { content: '{"items":[]}' } }] }));
    const c = new AiClient({ baseUrl: "https://ai.example", model: "ubm-todo", getKey: () => "vk-test", fetch: f });
    await c.classify(Array.from({ length: 7 }, () => "가".repeat(600)));
    const sent = JSON.parse(JSON.parse(f.mock.calls[0][1].body!).messages[1].content).sentences;
    expect(sent).toHaveLength(5);
    expect(sent[0].text).toHaveLength(500);
  });
  it("calls chat/completions with bearer key", async () => {
    const f = vi.fn<FetchLike>(async () => okJson({ choices: [{ message: { content: '{"items":[{"idx":0,"isTask":true,"title":"자료 공유","confidence":0.9,"dueText":""}]}' } }] }));
    const c = new AiClient({ baseUrl: "https://ai.example/", model: "ubm-todo", getKey: () => "vk-test", fetch: f });
    const v = await c.classify(["자료 공유 부탁"]);
    expect(v?.[0].isTask).toBe(true);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://ai.example/chat/completions");
    expect(init.headers.authorization).toBe("Bearer vk-test");
  });
  it("timeout / HTTP error → null (rule-only fallback)", async () => {
    const hang: FetchLike = (_u, init) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" }))));
    const c = new AiClient({ baseUrl: "x", model: "m", getKey: () => "sk-1", fetch: hang, timeoutMs: 20 });
    expect(await c.classify(["x"])).toBeNull();
    const c2 = new AiClient({ baseUrl: "x", model: "m", getKey: () => "sk-1", fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
    expect(await c2.classify(["x"])).toBeNull();
  });
  it("no key → nothing sent", async () => {
    const f = vi.fn<FetchLike>();
    const c = new AiClient({ baseUrl: "x", model: "m", getKey: () => undefined, fetch: f });
    expect(await c.classify(["x"])).toBeNull();
    expect(f).not.toHaveBeenCalled();
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
