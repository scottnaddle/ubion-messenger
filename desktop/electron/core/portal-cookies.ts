/**
 * Pure helpers for the in-app portal window (SSO): which URLs may load there and
 * how DaouClient's tough-cookie jar maps to Electron's session.cookies.set() details.
 * Never log cookie values.
 */
import type { Cookie } from "tough-cookie";

export type ElectronCookie = {
  url: string; name: string; value: string; domain?: string; path?: string;
  secure?: boolean; httpOnly?: boolean; expirationDate?: number; sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
};

/** Only http(s) URLs on the portal origin's host (coco.ubion.co.kr) may load in the portal window. */
export function isPortalUrl(url: string, baseUrl: string): boolean {
  try {
    const u = new URL(url), b = new URL(baseUrl);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname === b.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function toElectronCookie(c: Pick<Cookie, "key" | "value" | "domain" | "path" | "secure" | "httpOnly" | "expires" | "hostOnly" | "sameSite">, baseUrl: string): ElectronCookie {
  const b = new URL(baseUrl);
  const out: ElectronCookie = {
    url: `${b.protocol}//${b.host}${c.path || "/"}`, name: c.key, value: c.value,
    path: c.path || "/", secure: !!c.secure, httpOnly: !!c.httpOnly,
  };
  if (c.domain && !c.hostOnly) out.domain = c.domain; // host-only cookies: omit domain
  if (c.expires instanceof Date && !Number.isNaN(c.expires.getTime())) out.expirationDate = Math.floor(c.expires.getTime() / 1000);
  const ss = String(c.sameSite || "").toLowerCase();
  if (ss === "lax" || ss === "strict") out.sameSite = ss;
  else if (ss === "none") out.sameSite = "no_restriction";
  return out;
}
