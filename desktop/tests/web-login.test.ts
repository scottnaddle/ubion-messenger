import { describe, expect, it, vi, afterEach } from "vitest";
import {
  accountKey, fromElectronCookie, isWebLoginNavAllowed, isWebLoginSuccessUrl, markWebAccount, needsWebLogin,
  onSessionExpired, planLogin, unmarkWebAccount, webLoginUrl,
} from "../electron/core/web-login";
import { DaouClient, HttpError } from "../electron/core/daou-client";

const S = "https://coco.ubion.co.kr";

describe("web-login decisions", () => {
  it("offers web login for OTP / pending steps / session 403, not for wrong password", () => {
    expect(needsWebLogin({ phase: "login", status: 200, issue: "otp" })).toBe(true);
    expect(needsWebLogin({ phase: "login", status: 200, issue: "device" })).toBe(true);
    expect(needsWebLogin({ phase: "login", status: 200, issue: "password_change" })).toBe(true);
    expect(needsWebLogin({ phase: "login", status: 200, issue: "unknown", pendingRedirect: true })).toBe(true);
    expect(needsWebLogin({ phase: "login", status: 200, issue: null, flags: ["useOtp"] })).toBe(true);
    expect(needsWebLogin({ phase: "session", status: 403 })).toBe(true);
    expect(needsWebLogin({ phase: "login", status: 401, issue: "wrong_password" })).toBe(false);
    expect(needsWebLogin({ phase: "login", status: 403, issue: "locked" })).toBe(false);
    expect(needsWebLogin({ phase: "session", status: 500 })).toBe(false);
  });
  it("plans login per account", () => {
    expect(planLogin({ flagged: false, typedPassword: false })).toBe("native");
    expect(planLogin({ flagged: true, typedPassword: false })).toBe("web-silent");
    expect(planLogin({ flagged: true, typedPassword: true })).toBe("native");
  });
  it("session expiry: web sessions prompt once, never native relogin", () => {
    expect(onSessionExpired({ webSession: true, hasCreds: false, alreadyPrompted: false })).toBe("prompt-web");
    expect(onSessionExpired({ webSession: true, hasCreds: false, alreadyPrompted: true })).toBe("ignore");
    expect(onSessionExpired({ webSession: false, hasCreds: true, alreadyPrompted: false })).toBe("native-relogin");
    expect(onSessionExpired({ webSession: false, hasCreds: false, alreadyPrompted: false })).toBe("ignore");
  });
  it("account keys", () => {
    const k = accountKey(S + "/", " Scott ");
    expect(k).toBe("coco.ubion.co.kr|scott");
    expect(markWebAccount(markWebAccount([], k), k)).toEqual([k]);
    expect(unmarkWebAccount([k, "x"], k)).toEqual(["x"]);
  });
});

describe("web-login window URL policy", () => {
  it("restricts navigation to the server host", () => {
    expect(isWebLoginNavAllowed(S + "/login", S)).toBe(true);
    expect(isWebLoginNavAllowed(S + "/otp/auth?x=1", S)).toBe(true);
    expect(isWebLoginNavAllowed("https://evil.example/login", S)).toBe(false);
    expect(isWebLoginNavAllowed("https://coco.ubion.co.kr.evil.example/", S)).toBe(false);
    expect(isWebLoginNavAllowed("https://u:p@coco.ubion.co.kr/", S)).toBe(false);
    expect(isWebLoginNavAllowed("file:///etc/passwd", S)).toBe(false);
    expect(isWebLoginNavAllowed("javascript:alert(1)", S)).toBe(false);
    expect(isWebLoginNavAllowed("https://auth.example/", S, ["auth.example"])).toBe(true);
    expect(isWebLoginNavAllowed("http://auth.example/", S, ["auth.example"])).toBe(false);
  });
  it("detects success landing", () => {
    expect(isWebLoginSuccessUrl(S + "/app/home", S)).toBe(true);
    expect(isWebLoginSuccessUrl(S + "/app/", S)).toBe(true);
    expect(isWebLoginSuccessUrl(S + "/app/mail?x", S)).toBe(true);
    expect(isWebLoginSuccessUrl(S + "/login", S)).toBe(false);
    expect(isWebLoginSuccessUrl(S + "/app/otp/auth", S)).toBe(false);
    expect(isWebLoginSuccessUrl(S + "/app/password/change", S)).toBe(false);
    expect(isWebLoginSuccessUrl("https://other.example/app/home", S)).toBe(false);
    expect(webLoginUrl(S + "/")).toBe(S + "/login");
  });
  it("converts Electron cookies for the jar", () => {
    const c = fromElectronCookie({ name: "GOSSOcookie", value: "v", domain: ".ubion.co.kr", path: "/", secure: true, httpOnly: true, expirationDate: 2e9 });
    expect(c.key).toBe("GOSSOcookie");
    expect(c.domain).toBe("ubion.co.kr");
    expect(c.hostOnly).toBe(false);
    expect((c.expires as Date).getTime()).toBe(2e12);
    const h = fromElectronCookie({ name: "J", value: "v", domain: "coco.ubion.co.kr", session: true });
    expect(h.hostOnly).toBe(true);
    expect(h.expires).toBe("Infinity");
  });
});

describe("DaouClient web-login integration", () => {
  afterEach(() => vi.unstubAllGlobals());
  const res = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  it("flags 403 session check after 200 login as webLogin", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.endsWith("/api/login") ? res(200, { code: "200", data: {} }) : res(403, { code: "403", message: "forbidden" })));
    const c = new DaouClient(S);
    const e = await c.login({ serverUrl: S, username: "u", password: "p" }).catch((x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e.webLogin).toBe(true);
    expect(e.message).toContain("추가 인증(OTP)");
    expect(e.message).not.toContain("p\n");
  });
  it("flags OTP redirect after 200 login", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { code: "200", data: { redirect: "/otp/auth" } })));
    const e = await new DaouClient(S).login({ serverUrl: S, username: "u", password: "p" }).catch((x) => x);
    expect(e.webLogin).toBe(true);
  });
  it("wrong password is not a web-login case", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(401, { code: "401", message: "Invalid password" })));
    const e = await new DaouClient(S).login({ serverUrl: S, username: "u", password: "bad" }).catch((x) => x);
    expect(e.webLogin).toBe(false);
  });
  it("adopted web session: 401 prompts once and never POSTs /api/login", async () => {
    const calls: string[] = [];
    let ok = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push(`${init?.method || "GET"} ${new URL(url).pathname}`);
      if (!ok) return res(401, "");
      return res(200, { data: { id: 1, name: "n", loginId: "u", companyId: 1 } });
    }));
    const c = new DaouClient(S);
    const lost = vi.fn();
    c.onAuthLost = lost;
    const u = await c.adoptWebSession(S, [{ name: "GOSSOcookie", value: "v", domain: "coco.ubion.co.kr", path: "/" }]);
    expect(u.loginId).toBe("u");
    expect(c.webSession).toBe(true);
    ok = false;
    await c.request("/api/chat/rooms");
    await c.request("/api/chat/rooms");
    expect(lost).toHaveBeenCalledTimes(1);
    expect(calls.some((x) => x.includes("/api/login"))).toBe(false);
  });
});
