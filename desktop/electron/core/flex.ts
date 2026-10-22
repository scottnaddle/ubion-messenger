/**
 * flex.team helpers for the in-app portal window: start URL, login-page detection,
 * and a read-only pending-approval count. Never log credentials or cookie values.
 */

export const FLEX_INBOX = "https://flex.team/home/todo/inbox";
export const FLEX_LOGIN_PATH = "/auth/login";

export function isFlexLoginUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "flex.team" || u.hostname.endsWith(".flex.team"))
      && (u.pathname === FLEX_LOGIN_PATH || u.pathname.startsWith(`${FLEX_LOGIN_PATH}/`));
  } catch {
    return false;
  }
}

/** Build the company email Scott uses for flex (portal username + @ubion.co.kr). */
export function flexEmailFromUsername(username: string): string {
  const u = username.trim();
  if (!u) return "";
  if (u.includes("@")) return u;
  return `${u}@ubion.co.kr`;
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
