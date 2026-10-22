/**
 * DaouOffice login/session response interpretation.
 * Pure functions: never receive or log passwords. Diagnostics carry only status + code + message + redirect path.
 */
export type LoginIssue =
  | "wrong_password" | "locked" | "password_change" | "otp" | "ip_restricted"
  | "device" | "captcha" | "concurrent" | "forbidden" | "unknown";

export interface LoginDiag { status: number; code?: string; message?: string; redirect?: string; path: string }

const KO: Record<LoginIssue, string> = {
  wrong_password: "아이디 또는 비밀번호가 틀렸어요",
  locked: "계정이 잠겼어요. 관리자에게 잠금 해제를 요청해 주세요",
  password_change: "비밀번호 변경이 필요해요. 웹(그룹오피스)에서 먼저 비밀번호를 변경해 주세요",
  otp: "2단계 인증이 필요해요. 웹에서 인증을 완료하거나 관리자에게 문의해 주세요",
  ip_restricted: "허용되지 않은 접속이에요 (IP/접속 위치 제한)",
  device: "승인되지 않은 기기예요. 관리자에게 기기 승인을 요청해 주세요",
  captcha: "로그인 실패가 반복되어 보안문자 입력이 필요해요. 웹에서 한 번 로그인한 뒤 다시 시도해 주세요",
  concurrent: "다른 곳에서 이미 접속 중이라 로그인할 수 없어요",
  forbidden: "이 계정은 접근 권한이 없어요 (메신저/앱 사용 권한을 확인해 주세요)",
  unknown: "로그인하지 못했어요",
};

const RULES: Array<[LoginIssue, RegExp]> = [
  ["otp", /otp|2fa|two.?factor|second.?auth|2단계|추가\s*인증|인증\s*번호|mfa/i],
  ["password_change", /pw.?change|password.?(change|expire)|change.?password|passwordchange|비밀번호.*(변경|만료)|expired/i],
  ["locked", /lock|잠금|잠겼|잠긴|disabled|stop|정지|휴면|dormant/i],
  ["captcha", /captcha|보안\s*문자|자동입력/i],
  ["ip_restricted", /\bip\b|ip.?(deny|restrict|block)|access.?ip|허용되지\s*않은\s*(ip|접속)|접속\s*(제한|차단)/i],
  ["device", /device|기기|단말/i],
  ["concurrent", /concurrent|duplicate.?login|already.?logged|중복\s*로그인|동시\s*접속/i],
  ["wrong_password", /invalid.?(password|credential|user)|wrong|mismatch|bad.?credential|not.?match|비밀번호.*(틀|일치)|아이디.*(없|틀|일치)|login.?fail/i],
];

export function parseBody(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

function decode(s: string) { try { return decodeURIComponent(s); } catch { return s; } }

/** Strip tags, cap length; never echo HTML pages verbatim. */
function cleanText(t: string): string | undefined {
  if (!t || /<html|<!doctype/i.test(t)) return undefined;
  const s = t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 200) : undefined;
}

export function diagnose(status: number, text: string, path: string): LoginDiag {
  const b = parseBody(text);
  const d: LoginDiag = { status, path };
  if (b && typeof b === "object") {
    const code = b.code ?? b.errorCode ?? b.error ?? b.name;
    if (code != null) d.code = String(code).slice(0, 80);
    const msg = b.message ?? b.msg ?? b.errorMessage ?? b.data?.message;
    if (msg) d.message = String(msg).slice(0, 200);
    const r = b.data?.redirect ?? b.redirect ?? b.data?.returnUrl;
    if (r) d.redirect = decode(String(r)).split("?")[0].slice(0, 120);
  } else {
    d.message = cleanText(text);
  }
  return d;
}

export function classify(d: LoginDiag, extraFlags: string[] = []): LoginIssue | null {
  const hay = [d.code, d.message, d.redirect, ...extraFlags].filter(Boolean).join(" ");
  for (const [k, re] of RULES) if (re.test(hay)) return k;
  if (d.status === 401) return "wrong_password";
  return null;
}

/** Redirect after a "successful" login that is NOT the normal home: a pending step (pw change, OTP, device...). */
export function isPendingRedirect(redirect?: string): boolean {
  if (!redirect) return false;
  return !/^\/?(app\/home|app\/?$|$)/.test(redirect.replace(/^https?:\/\/[^/]+/, ""));
}

/** Safe one-line diagnostic for UI/log: no credentials, no cookies. */
export function diagLine(d: LoginDiag): string {
  const parts = [`${d.path} ${d.status}`];
  if (d.code) parts.push(`code=${d.code}`);
  if (d.message) parts.push(`msg=${d.message}`);
  if (d.redirect) parts.push(`redirect=${d.redirect}`);
  return parts.join(" ");
}

/** Korean user message: known issue → clear text; else server message; never raw "HTTP 403". */
export function userMessage(d: LoginDiag, issue: LoginIssue | null): string {
  const base = issue ? KO[issue] : d.message || (d.status === 403 ? KO.forbidden : KO.unknown);
  return `${base}\n[진단] ${diagLine(d)}`;
}

/** Mask sensitive fields in any object before logging. */
export function maskSecrets<T>(o: T): T {
  if (!o || typeof o !== "object") return o;
  const out: any = Array.isArray(o) ? [] : {};
  for (const [k, v] of Object.entries(o as any)) {
    out[k] = /pass|pwd|secret|token|cookie|otp|captcha|subinfo/i.test(k) ? "<MASK>" : maskSecrets(v);
  }
  return out;
}
