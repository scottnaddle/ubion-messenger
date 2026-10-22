import { describe, expect, it } from "vitest";
import { classify, diagLine, diagnose, isPendingRedirect, maskSecrets, userMessage } from "../electron/core/login-errors";

const msg = (s: number, t: string, p = "/api/login") => { const d = diagnose(s, t, p); return userMessage(d, classify(d)); };

describe("login errors", () => {
  it("maps known cases to Korean", () => {
    expect(msg(401, '{"code":"401","message":"Invalid password"}')).toContain("비밀번호가 틀렸어요");
    expect(msg(403, '{"code":"ACCOUNT_LOCKED","message":"locked"}')).toContain("계정이 잠겼어요");
    expect(msg(403, '{"code":"403","message":"비밀번호가 만료되었습니다"}')).toContain("비밀번호 변경이 필요해요");
    expect(msg(403, '{"code":"OTP_REQUIRED"}')).toContain("2단계 인증이 필요해요");
    expect(msg(403, '{"message":"허용되지 않은 IP입니다"}')).toContain("허용되지 않은 접속");
    expect(msg(403, '{"message":"승인되지 않은 기기"}')).toContain("승인되지 않은 기기");
    expect(msg(403, '{"code":"CAPTCHA_REQUIRED"}')).toContain("보안문자");
  });
  it("falls back to server message, never bare HTTP", () => {
    const m = msg(403, '{"code":"X9","message":"메신저 사용 권한이 없습니다"}', "/api/user/session");
    expect(m).toContain("메신저 사용 권한이 없습니다");
    expect(m.startsWith("HTTP")).toBe(false);
    expect(msg(403, "<html>forbidden</html>", "/api/user/session")).toContain("접근 권한이 없어요");
    expect(msg(403, "plain denied")).toContain("plain denied");
  });
  it("detects pending redirect after 200 login", () => {
    expect(isPendingRedirect("/app/home")).toBe(false);
    expect(isPendingRedirect(undefined)).toBe(false);
    const d = diagnose(200, '{"code":"200","data":{"redirect":"%2Fapp%2Fpassword%2Fchange"}}', "/api/login");
    expect(d.redirect).toBe("/app/password/change");
    expect(isPendingRedirect(d.redirect)).toBe(true);
    expect(classify(d)).toBe("password_change");
    expect(classify(diagnose(200, '{"data":{"redirect":"/otp/auth"}}', "/api/login"))).toBe("otp");
  });
  it("diag and mask never leak secrets", () => {
    const d = diagnose(403, '{"code":"E1","message":"m","password":"hunter2"}', "/api/login");
    expect(diagLine(d)).not.toContain("hunter2");
    expect(maskSecrets({ username: "u", password: "p", nested: { otpCode: "1" } })).toEqual({ username: "u", password: "<MASK>", nested: { otpCode: "<MASK>" } });
  });
});
