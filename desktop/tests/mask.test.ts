import { describe, expect, it } from "vitest";
import { maskSecrets } from "../electron/core/mask";

describe("maskSecrets", () => {
  it("redacts session and cookie header values", () => {
    expect(maskSecrets("X-Daou-Session: abc.def; ghi")).toBe("X-Daou-Session: ***");
    expect(maskSecrets("Cookie: GOSSOcookie=secret; other=value")).toBe("Cookie: ***");
    expect(maskSecrets("x-daou-session=abc")).toBe("x-daou-session=***");
  });

  it("redacts pin/password/token values", () => {
    expect(maskSecrets("pin=1234")).toBe("pin=***");
    expect(maskSecrets("password: hunter2")).toBe("password: ***");
    expect(maskSecrets("token: abc.def")).toBe("token: ***");
    expect(maskSecrets('"password":"secret"')).toBe('"password":"***"');
    expect(maskSecrets('{"pin":"1234","token":"abc"}')).toBe('{"pin":"***","token":"***"}');
  });

  it("never leaves the original secret in the output", () => {
    const text = 'X-Daou-Session: cookie-secret Cookie: c=1 "pin":"9876" password=hunter2 token=tok-1';
    const masked = maskSecrets(text);
    for (const secret of ["cookie-secret", "c=1", "9876", "hunter2", "tok-1"]) {
      expect(masked).not.toContain(secret);
    }
  });

  it("leaves normal text untouched", () => {
    expect(maskSecrets("메시지를 전송했습니다")).toBe("메시지를 전송했습니다");
    expect(maskSecrets("pinned message")).toBe("pinned message");
  });
});
