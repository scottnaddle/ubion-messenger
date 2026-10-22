/**
 * Web-login fallback for accounts the native /api/login flow can't complete
 * (OTP / 2-step, device approval, password change, other pending redirects, or a
 * session-check 403 right after a 200 login).
 * Pure decision helpers only (unit-tested). Never receives or logs passwords, OTP codes or cookie values.
 */
import { Cookie } from "tough-cookie";
import type { LoginIssue } from "./login-errors";

/** Issues the user can resolve by completing the server's own web login page. */
const WEB_ISSUES: ReadonlySet<LoginIssue> = new Set<LoginIssue>(["otp", "device", "password_change", "captcha"]);

export type LoginFailure = {
  /** "login" = POST /api/login; "session" = GET /api/user/session right after a 200 login. */
  phase: "login" | "session";
  status: number;
  issue?: LoginIssue | null;
  /** 200 login whose redirect is not the normal home. */
  pendingRedirect?: boolean;
  /** true-valued OTP/device/... flags seen in the login body. */
  flags?: string[];
};

/** Should we offer "웹에서 인증하고 로그인" instead of just showing the error? */
export function needsWebLogin(f: LoginFailure): boolean {
  if (f.phase === "session") return f.status === 403 || f.status === 401;
  if (f.pendingRedirect || (f.flags && f.flags.length)) return true;
  return !!f.issue && WEB_ISSUES.has(f.issue);
}

export const WEB_LOGIN_MESSAGE = "이 계정은 추가 인증(OTP)이 필요해요";
export const WEB_LOGIN_BUTTON = "웹에서 인증하고 로그인";

/** Per-account key: server host + lower-cased login id. Contains no secret. */
export function accountKey(serverUrl: string, username: string): string {
  let host = serverUrl;
  try { host = new URL(serverUrl).host; } catch { /* keep raw */ }
  return `${host.toLowerCase()}|${username.trim().toLowerCase()}`;
}
export function markWebAccount(list: string[] | undefined, key: string): string[] {
  const l = list || [];
  return l.includes(key) ? l : [...l, key];
}
export function unmarkWebAccount(list: string[] | undefined, key: string): string[] {
  return (list || []).filter((k) => k !== key);
}

export type LoginPlan = "native" | "web-silent" | "web-prompt";
/**
 * How to log in.
 * - Account not flagged → native (POST /api/login).
 * - Flagged + password typed by the user now → native once (OTP may have been turned off; a correct password is not a lockout risk).
 * - Flagged + saved password / auto-login → never native: try the stored web cookies silently, then prompt the web window.
 */
export function planLogin(o: { flagged: boolean; typedPassword: boolean }): LoginPlan {
  if (!o.flagged) return "native";
  return o.typedPassword ? "native" : "web-silent";
}

/** What to do when an authenticated request gets 401 (session expired). */
export function onSessionExpired(o: { webSession: boolean; hasCreds: boolean; alreadyPrompted: boolean }): "native-relogin" | "prompt-web" | "ignore" {
  if (o.webSession) return o.alreadyPrompted ? "ignore" : "prompt-web";
  return o.hasCreds ? "native-relogin" : "ignore";
}

// ---------------- web window URL policy ----------------
/** Extra hosts an auth chain may legitimately pass through (exact match). Keep minimal. */
export const AUTH_HOSTS: string[] = [];

function parse(u: string): URL | null {
  try { return new URL(u); } catch { return null; }
}

/** Navigation allowed inside the web-login window: the server host (same scheme family) or AUTH_HOSTS, https only for the latter. */
export function isWebLoginNavAllowed(url: string, serverUrl: string, extraHosts: string[] = AUTH_HOSTS): boolean {
  const u = parse(url), b = parse(serverUrl);
  if (!u || !b || u.username || u.password) return false;
  if (u.protocol === "about:" && url === "about:blank") return true;
  if (u.hostname === b.hostname) return u.protocol === b.protocol || u.protocol === "https:";
  return u.protocol === "https:" && extraHosts.includes(u.hostname);
}

/** Landed in the app after login (/app/home, /app, /app/<something> other than auth steps). */
export function isWebLoginSuccessUrl(url: string, serverUrl: string): boolean {
  const u = parse(url), b = parse(serverUrl);
  if (!u || !b || u.hostname !== b.hostname) return false;
  const p = u.pathname.replace(/\/+$/, "") || "/";
  if (/login|otp|auth|password|pwd|device|captcha|logout/i.test(p)) return false;
  return p === "/app" || p.startsWith("/app/");
}

export function webLoginUrl(serverUrl: string): string {
  return serverUrl.replace(/\/$/, "") + "/login";
}

// ---------------- cookie copy (Electron session → tough-cookie jar) ----------------
export type ElectronCookieIn = {
  name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean;
  hostOnly?: boolean; expirationDate?: number; session?: boolean; sameSite?: string;
};

/** Convert an Electron cookie to a tough-cookie Cookie for the API client's jar. */
export function fromElectronCookie(c: ElectronCookieIn): Cookie {
  const sameSite = c.sameSite === "lax" || c.sameSite === "strict" ? c.sameSite : c.sameSite === "no_restriction" ? "none" : undefined;
  return new Cookie({
    key: c.name,
    value: c.value,
    domain: (c.domain || "").replace(/^\./, "") || null,
    path: c.path || "/",
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    hostOnly: c.hostOnly ?? !(c.domain || "").startsWith("."),
    expires: c.expirationDate && !c.session ? new Date(c.expirationDate * 1000) : "Infinity",
    sameSite,
  });
}
