import { describe, expect, it, vi } from "vitest";
import {
  base64ToBytes, bodyToString, createNativeFetch, headerValue, responseBytes, setCookieList, splitSetCookie, type NativeHttp,
} from "../src/platform/http";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("mobile http adapter: Set-Cookie parsing", () => {
  it("splits comma-joined cookies but keeps the comma inside Expires", () => {
    expect(splitSetCookie("A=1; Path=/; HttpOnly, B=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, C=3")).toEqual([
      "A=1; Path=/; HttpOnly",
      "B=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
      "C=3",
    ]);
  });
  it("single cookie with an Expires date stays whole", () => {
    expect(splitSetCookie("A=1; Expires=Thu, 01 Jan 2027 00:00:00 GMT")).toEqual(["A=1; Expires=Thu, 01 Jan 2027 00:00:00 GMT"]);
  });
  it("accepts any header-name case, arrays, and ignores other headers", () => {
    expect(setCookieList({ "Set-Cookie": ["A=1; Path=/", "B=2, C=3"], "content-type": "text/html" })).toEqual(["A=1; Path=/", "B=2", "C=3"]);
    expect(setCookieList({ "set-cookie": "X=9" })).toEqual(["X=9"]);
    expect(setCookieList({})).toEqual([]);
    expect(setCookieList(undefined)).toEqual([]);
  });
  it("headerValue is case-insensitive", () => {
    expect(headerValue({ Location: "/login" }, "location")).toBe("/login");
    expect(headerValue({ "Content-Type": "application/json" }, "content-type")).toBe("application/json");
    expect(headerValue({}, "x")).toBeNull();
  });
});

describe("mobile http adapter: bodies", () => {
  it("decodes base64 / ArrayBuffer / text / JSON response data", () => {
    expect(new TextDecoder().decode(responseBytes(b64("안녕"), true))).toBe("안녕");
    expect(Array.from(responseBytes(new Uint8Array([1, 2]).buffer, true))).toEqual([1, 2]);
    expect(new TextDecoder().decode(responseBytes({ a: 1 }, true))).toBe('{"a":1}');
    expect(new TextDecoder().decode(responseBytes("plain", false))).toBe("plain");
    expect(responseBytes(null, true).length).toBe(0);
    expect(Array.from(base64ToBytes("AAE="))).toEqual([0, 1]);
  });
  it("request bodies must be UTF-8 text (binary uploads are refused, not corrupted)", () => {
    expect(bodyToString(new TextEncoder().encode("a=1&b=한"))).toBe("a=1&b=한");
    expect(bodyToString("x")).toBe("x");
    expect(bodyToString(undefined)).toBeUndefined();
    expect(() => bodyToString(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow("바이너리");
  });
});

describe("createNativeFetch (mocked CapacitorHttp)", () => {
  it("passes method/headers/body, disables redirects, and exposes status/headers/cookies/bytes", async () => {
    const request = vi.fn<NativeHttp["request"]>(async () => ({
      status: 302,
      headers: { Location: "/app/home", "Set-Cookie": "GOSSOcookie=s3cr3t; Path=/; HttpOnly, lang=ko; Expires=Wed, 21 Oct 2026 07:28:00 GMT" },
      data: b64('{"ok":true}'),
    }));
    const f = createNativeFetch({ request });
    const res = await f("https://example.test/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: new TextEncoder().encode('{"u":1}'), redirect: "manual",
    });
    expect(request).toHaveBeenCalledTimes(1);
    const o = request.mock.calls[0][0];
    expect(o).toMatchObject({ url: "https://example.test/api/login", method: "POST", data: '{"u":1}', disableRedirects: true, responseType: "arraybuffer" });
    expect(o.headers).toEqual({ "Content-Type": "application/json" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/home");
    expect(res.headers.getSetCookie?.()).toEqual(["GOSSOcookie=s3cr3t; Path=/; HttpOnly", "lang=ko; Expires=Wed, 21 Oct 2026 07:28:00 GMT"]);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe('{"ok":true}');
  });
  it("GET without body sends no data; aborted signal rejects", async () => {
    const request = vi.fn<NativeHttp["request"]>(async () => ({ status: 200, headers: {}, data: "" }));
    const f = createNativeFetch({ request });
    await f("https://example.test/x", { method: "GET", headers: {}, redirect: "manual" });
    expect("data" in request.mock.calls[0][0]).toBe(false);
    const ac = new AbortController();
    ac.abort();
    await expect(f("https://example.test/x", { method: "GET", headers: {}, redirect: "manual", signal: ac.signal })).rejects.toThrow("aborted");
  });
});
