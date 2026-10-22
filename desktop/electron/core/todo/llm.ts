/**
 * Optional DeepSeek-assisted extraction (OpenAI-compatible chat/completions).
 * OFF by default. Only ambiguous-band (0.5–0.85) sentences, masked, are sent.
 * Dates are always finalized by rules (normalizeKoreanDate); the model only gives a span.
 */
import { normalizeKoreanDate } from "./dates-ko";

export const LLM_BAND = { min: 0.5, max: 0.85 };
export const DEFAULT_LLM_BASE = "https://api.deepseek.com";
export const DEFAULT_LLM_MODEL = "deepseek-chat";

export type LlmVerdict = { idx: number; isTask: boolean; title?: string; confidence: number; dueText?: string };
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export function inBand(score: number) {
  return score >= LLM_BAND.min && score < LLM_BAND.max;
}

/** Mask personal data before anything leaves the device. */
export function maskForLlm(text: string, names: string[] = []): string {
  let t = text;
  t = t.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<EMAIL>");
  t = t.replace(/https?:\/\/\S+/gi, "<URL>");
  t = t.replace(/(?:비밀번호|비번|암호|passcode|password|pwd|pw|코드)\s*[:：=]?\s*\S+/gi, "<PASSCODE>");
  t = t.replace(/\b(?:\d{3}\s?\d{3,4}\s?\d{4}|\d{9,11})\b/g, "<ID>");
  t = t.replace(/(?:\+?82[-\s]?)?0?1[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/g, "<PHONE>");
  t = t.replace(/\b0\d{1,2}[-\s.]\d{3,4}[-\s.]\d{4}\b/g, "<PHONE>");
  t = t.replace(/\b[A-Za-z0-9_-]{24,}\b/g, "<TOKEN>");
  for (const n of [...new Set(names.filter((x) => x && x.length >= 2))].sort((a, b) => b.length - a.length)) {
    t = t.split(n).join("<NAME>");
  }
  t = t.replace(/([가-힣]{2,4})\s?(님|씨)/g, (m, a, b) => (/^(과장|차장|부장|팀장|대리|사원|이사|대표|매니저|프로|선생|고객)$/.test(a) ? m : "<NAME>" + b));
  return t;
}

export const SYSTEM_PROMPT =
  "You classify Korean workplace chat sentences as actionable to-dos. " +
  'Return ONLY JSON: {"items":[{"idx":number,"isTask":boolean,"title":string,"confidence":number,"dueText":string}]}. ' +
  'title: short Korean to-do (<=30 chars), no names. dueText: the exact date/time phrase from the sentence or "". ' +
  "confidence 0..1. Placeholders like <NAME> are masked data; never guess them.";

export function buildRequest(model: string, sentences: string[]) {
  return {
    model,
    temperature: 0,
    max_tokens: 400,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ sentences: sentences.map((text, idx) => ({ idx, text })) }) },
    ],
  };
}

/** Strict parse; anything malformed → null (caller keeps rule result). */
export function parseVerdicts(content: string, n: number): LlmVerdict[] | null {
  let obj: any;
  try {
    obj = JSON.parse(content.trim().replace(/^```(?:json)?|```$/g, ""));
  } catch {
    return null;
  }
  if (!obj || !Array.isArray(obj.items)) return null;
  const out: LlmVerdict[] = [];
  for (const it of obj.items) {
    if (typeof it?.idx !== "number" || it.idx < 0 || it.idx >= n || typeof it.isTask !== "boolean") continue;
    const c = Number(it.confidence);
    out.push({
      idx: it.idx,
      isTask: it.isTask,
      title: typeof it.title === "string" ? it.title.replace(/<[A-Z]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 40) : undefined,
      confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5,
      dueText: typeof it.dueText === "string" ? it.dueText.slice(0, 40) : undefined,
    });
  }
  return out;
}

/** Rules finalize dates: only a dueText the rules can parse is used. */
export function finalizeDue(dueText: string | undefined, anchorIso: string): string | undefined {
  if (!dueText) return undefined;
  return normalizeKoreanDate(dueText, anchorIso)?.iso;
}

const scrub = (s: string) => s.replace(/sk-[\w-]+/g, "sk-***");

export class DeepSeekClient {
  constructor(
    private opts: { baseUrl: string; model: string; getKey: () => string | undefined; fetch: FetchLike; timeoutMs?: number },
  ) {}

  private async call(path: string, body?: any, method = "POST") {
    const key = this.opts.getKey();
    if (!key) throw new Error("API 키 없음");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs ?? 8000);
    try {
      const res = await this.opts.fetch(this.opts.baseUrl.replace(/\/+$/, "") + path, {
        method,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Connection test: GET /models (no chat content sent). */
  async test(): Promise<{ ok: boolean; message: string; models?: string[] }> {
    try {
      const j = await this.call("/models", undefined, "GET");
      const models = (j?.data || []).map((m: any) => String(m.id));
      return { ok: true, message: models.includes(this.opts.model) ? "연결됨" : "연결됨 (모델 이름을 확인하세요)", models };
    } catch (e: any) {
      return { ok: false, message: e?.name === "AbortError" ? "시간 초과" : scrub(String(e?.message || e)) };
    }
  }

  async classify(masked: string[]): Promise<LlmVerdict[] | null> {
    try {
      const j = await this.call("/chat/completions", buildRequest(this.opts.model, masked));
      const content = j?.choices?.[0]?.message?.content;
      return typeof content === "string" ? parseVerdicts(content, masked.length) : null;
    } catch {
      return null; // timeout / network / HTTP error → rule-only
    }
  }
}

export type LlmJob = { id: string; text: string; names: string[]; anchorIso: string; done: (v: LlmVerdict | null) => void };

/** Light queue: batches up to `batch` jobs, at most `perMinute` requests, drops when backlog > maxQueue. */
export class LlmQueue {
  private q: LlmJob[] = [];
  private stamps: number[] = [];
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private classify: (masked: string[]) => Promise<LlmVerdict[] | null>,
    private opts = { batch: 5, perMinute: 6, maxQueue: 30, delayMs: 1500 },
    private now: () => number = Date.now,
  ) {}

  size() {
    return this.q.length;
  }

  push(job: LlmJob) {
    if (this.q.length >= this.opts.maxQueue) {
      job.done(null);
      return false;
    }
    this.q.push(job);
    this.schedule(this.opts.delayMs);
    return true;
  }

  private schedule(ms: number) {
    if (this.timer || this.busy) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  async flush() {
    if (this.busy || !this.q.length) return;
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 60_000);
    if (this.stamps.length >= this.opts.perMinute) {
      this.schedule(60_000 - (t - this.stamps[0]) + 10);
      return;
    }
    this.busy = true;
    this.stamps.push(t);
    const jobs = this.q.splice(0, this.opts.batch);
    let verdicts: LlmVerdict[] | null = null;
    try {
      verdicts = await this.classify(jobs.map((j) => maskForLlm(j.text, j.names)));
    } catch {
      verdicts = null;
    }
    jobs.forEach((j, i) => j.done(verdicts?.find((v) => v.idx === i) || null));
    this.busy = false;
    if (this.q.length) this.schedule(this.opts.delayMs);
  }
}
