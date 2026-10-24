/**
 * flex.team helpers for the in-app portal window: start URL, login-page detection,
 * and a read-only pending-approval count. Never log credentials or cookie values.
 */

export const FLEX_INBOX = "https://flex.team/home/todo/inbox";
export const FLEX_LOGIN_PATH = "/auth/login";

/**
 * The flex SPA loads 할 일 via this endpoint (POST only — GET returns 405).
 * Body filters TODO+IN_PROGRESS (= UI "진행"). Response.total matches the inbox badge.
 * Read-only: never approve/reject/modify.
 */
export const FLEX_TODO_SEARCH =
  "/action/v3/todo/assigned-todos/search?size=1&sort=DESC&orderBy=UPDATED_AT";
export const FLEX_TODO_PENDING_BODY = {
  condition: "AND",
  filter: { statuses: { selections: ["TODO", "IN_PROGRESS"], condition: "INCLUDE_ALL" } },
} as const;


export function isFlexLoginUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "flex.team" || u.hostname.endsWith(".flex.team"))
      && (u.pathname === FLEX_LOGIN_PATH || u.pathname.startsWith(`${FLEX_LOGIN_PATH}/`));
  } catch {
    return false;
  }
}

/**
 * Build the flex login email. Default domain is Ubion's (portal id + @ubion.co.kr).
 * Pass null on the generic flavor so a bare username is never rewritten to @ubion.co.kr.
 */
export function flexEmailFromUsername(username: string, domain: string | null = "ubion.co.kr"): string {
  const u = username.trim();
  if (!u) return "";
  if (u.includes("@")) return u;
  const host = (domain || "").trim().replace(/^@/, "");
  if (!host) return "";
  return `${u}@${host}`;
}

/**
 * Page script: fill email → 계속 → password → 로그인하기.
 * Credentials are injected by the main process only; the return value never includes them.
 * Returns a short status string for logs: "ok" | "no-form" | "no-email" | "no-password" | "error".
 */
export function flexAutoLoginScript(email: string, password: string): string {
  // JSON.stringify keeps the values string-literal-safe inside the IIFE.
  return `(() => {
  const email = ${JSON.stringify(email)};
  const password = ${JSON.stringify(password)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setVal = (el, v) => {
    if (!el) return;
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const btn = (label) => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === label);
  const emailInput = () => document.querySelector('input[type="email"], input[name="email"], input[autocomplete="username"], input[autocomplete="email"], input:not([type="password"]):not([type="hidden"])');
  const pwInput = () => document.querySelector('input[type="password"]');
  return (async () => {
    try {
      if (!email || !password) return "no-creds";
      let e = emailInput();
      if (!e) return "no-form";
      if (!pwInput()) {
        setVal(e, email);
        const c = btn("계속");
        if (!c) return "no-email";
        c.click();
        for (let i = 0; i < 40; i++) { await sleep(250); if (pwInput()) break; }
      }
      const p = pwInput();
      if (!p) return "no-password";
      setVal(p, password);
      const go = btn("로그인하기") || btn("로그인");
      if (!go) return "no-password";
      go.click();
      return "ok";
    } catch {
      return "error";
    }
  })();
})()`;
}

/** Mask anything that looks like a token/secret in a log line. */
export function maskFlexLog(s: string): string {
  return s
    .replace(/\S+@\S+/g, "<email>")
    .replace(/((?:[?&]|^|\s)(?:token|t|code|key|auth|otp|jwt|password|passwd|pwd)=)[^&\s]+/gi, "$1<MASK>")
    .replace(/Bearer\s+\S+/gi, "Bearer <MASK>");
}

/** Parse pending count from assigned-todos/search JSON ({ total }). */
export function parseFlexTodoTotal(json: unknown): number | null {
  if (json == null || typeof json !== "object") return null;
  const t = (json as { total?: unknown }).total;
  return typeof t === "number" && Number.isFinite(t) && t >= 0 ? t : null;
}

/** DOM scrape for the inbox "진행 (N)" badge (read-only). */
export function flexProgressCountFromText(text: string): number | null {
  const m = text.match(/진행\s*\((\d{1,4})\)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
