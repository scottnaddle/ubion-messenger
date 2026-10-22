import { describe, expect, it } from "vitest";
import { Cookie } from "tough-cookie";
import { isPortalUrl, toElectronCookie } from "../electron/core/portal-cookies";

const BASE = "https://coco.ubion.co.kr";
describe("portal window helpers", () => {
  it("only portal host loads in-app", () => {
    expect(isPortalUrl("https://coco.ubion.co.kr/app/board", BASE)).toBe(true);
    expect(isPortalUrl("https://coco.ubion.co.kr/login?returnUrl=%2Fapp", BASE)).toBe(true);
    expect(isPortalUrl("https://evil.com/?coco.ubion.co.kr", BASE)).toBe(false);
    expect(isPortalUrl("https://coco.ubion.co.kr.evil.com/", BASE)).toBe(false);
    expect(isPortalUrl("https://u:p@coco.ubion.co.kr/", BASE)).toBe(false);
    expect(isPortalUrl("javascript:alert(1)", BASE)).toBe(false);
    expect(isPortalUrl("file:///etc/passwd", BASE)).toBe(false);
  });
  it("maps jar cookies to electron cookie details", () => {
    const c = Cookie.parse("GOSSOcookie=abc; Path=/; Secure; HttpOnly; SameSite=Lax")!;
    c.hostOnly = true;
    expect(toElectronCookie(c, BASE)).toEqual({ url: "https://coco.ubion.co.kr/", name: "GOSSOcookie", value: "abc", path: "/", secure: true, httpOnly: true, sameSite: "lax" });
    const d = Cookie.parse("X=1; Domain=ubion.co.kr; Path=/app; Expires=Wed, 21 Oct 2037 07:28:00 GMT; SameSite=None")!;
    d.hostOnly = false;
    expect(toElectronCookie(d, BASE)).toMatchObject({ url: "https://coco.ubion.co.kr/app", domain: "ubion.co.kr", path: "/app", sameSite: "no_restriction", expirationDate: 2139722880 });
  });
});
