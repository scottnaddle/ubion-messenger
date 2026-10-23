import { afterEach, describe, expect, it, vi } from "vitest";
import { DaouClient } from "../electron/core/daou-client";
import { MessengerCore } from "../electron/core/messenger";
import { maskSecrets } from "../electron/core/mask";
import {
  extractZoomRedirect, isZoomAuthError, parseMeeting, parseZoomConfig, parseZoomTokenMessage, resolveZoomClientId,
  zoomAuthorizeUrl, zoomCaps, zoomEnabled, zoomMeetingForm, zoomRedirectUri, zoomState,
  ZOOM_CONFIG_PATH, ZOOM_DEFAULT_CLIENT_ID, ZOOM_DISABLED_TEXT, ZOOM_MEETING_PATH,
} from "../electron/core/zoom";

const reply = (text = "", status = 200) =>
  new Response(text, { status, headers: { "content-type": "application/json" } });

function client() {
  const c = new DaouClient("https://daou.example");
  c.user = { id: 42, repId: 42, name: "나", loginId: "me", companyId: 1 };
  return c;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("zoom helpers", () => {
  it("builds the authorize URL like the original", () => {
    expect(zoomAuthorizeUrl("abc123", "https://daou.example/zoom/accesstoken")).toBe(
      "https://zoom.us/oauth/authorize?response_type=code&client_id=abc123&redirect_uri=https%3A%2F%2Fdaou.example%2Fzoom%2Faccesstoken"
    );
    expect(zoomAuthorizeUrl("abc", "https://d.example/zoom/accesstoken", "eyJ+/=")).toMatch(/&state=eyJ%2B%2F%3D$/);
    expect(() => zoomAuthorizeUrl("", "https://d.example/x")).toThrow();
    expect(() => zoomAuthorizeUrl("a&b=c", "https://d.example/x")).toThrow();
    expect(() => zoomAuthorizeUrl("abc", "javascript:alert(1)")).toThrow();
  });

  it("derives redirect URI and base64 state", () => {
    expect(zoomRedirectUri("https://coco.ubion.co.kr/")).toBe("https://coco.ubion.co.kr/zoom/accesstoken");
    const state = zoomState({ resource: "go_pc_42_123_ubion", userSeq: 42, roomSeq: 7 });
    expect(JSON.parse(Buffer.from(state, "base64").toString("utf8"))).toEqual({ resource: "go_pc_42_123_ubion", userSeq: 42, roomSeq: 7 });
  });

  it("parses config defensively", () => {
    expect(parseZoomConfig({ data: { useZoomChat: true, zoomClientId: "cid1" } })).toEqual({ use: true, clientId: "cid1" });
    expect(parseZoomConfig({ useZoomChat: false })).toEqual({ use: false });
    expect(parseZoomConfig({ videoChatOption: { isZoomSupported: true, zoomInfo: { clientId: "cid2", use: true } } })).toEqual({ use: true, clientId: "cid2" });
    expect(parseZoomConfig({ data: { useZoomChat: "Y", zoomClientId: "bad id!" } })).toEqual({ use: true });
    expect(parseZoomConfig({ data: { chatConfigModel: {} } })).toBeUndefined();
    expect(parseZoomConfig(null)).toBeUndefined();
    expect(parseZoomConfig("x")).toBeUndefined();
  });

  it("resolves client id: param > config > documented default", () => {
    expect(resolveZoomClientId({ use: true, clientId: "cfg" }, "override")).toEqual({ clientId: "override", source: "param" });
    expect(resolveZoomClientId({ use: true, clientId: "cfg" })).toEqual({ clientId: "cfg", source: "config" });
    expect(resolveZoomClientId({ use: true }, "  ")).toEqual({ clientId: ZOOM_DEFAULT_CLIENT_ID, source: "default" });
    expect(resolveZoomClientId(undefined)).toEqual({ clientId: ZOOM_DEFAULT_CLIENT_ID, source: "default" });
  });

  it("extracts token / code / error only from the redirect URI", () => {
    const r = "https://daou.example/zoom/accesstoken";
    expect(extractZoomRedirect("https://zoom.us/signin?code=x", r)).toBeNull();
    expect(extractZoomRedirect("https://evil.example/zoom/accesstoken?code=x", r)).toBeNull();
    expect(extractZoomRedirect(`${r}?code=abc&state=s`, r)).toEqual({ code: "abc" });
    expect(extractZoomRedirect(`${r}/#access_token=tok`, r)).toEqual({ accessToken: "tok" });
    expect(extractZoomRedirect(`${r}?error=access_denied`, r)).toEqual({ error: "access_denied" });
    expect(extractZoomRedirect(r, r)).toEqual({});
    expect(extractZoomRedirect("not a url", r)).toBeNull();
  });

  it("parses the XMPP zoom token message (escaped JSON)", () => {
    const message = '{\\"access_token\\":\\"AT\\",\\"refresh_token\\":\\"RT\\",\\"expires_in\\":3599}';
    expect(parseZoomTokenMessage({ actiontype: "zoom", message })).toEqual({ accessToken: "AT", refreshToken: "RT", expiresIn: 3599 });
    expect(parseZoomTokenMessage({ accessToken: "AT2" })).toEqual({ accessToken: "AT2" });
    expect(parseZoomTokenMessage({ message: "not json" })).toBeUndefined();
    expect(parseZoomTokenMessage({ message: "{}" })).toBeUndefined();
  });

  it("parses meetings and auth errors", () => {
    expect(parseMeeting({ data: { joinUrl: "https://zoom.us/j/123" } })).toEqual({ joinUrl: "https://zoom.us/j/123" });
    expect(parseMeeting('{"joinUrl":"https://zoom.us/j/9"}')).toEqual({ joinUrl: "https://zoom.us/j/9" });
    expect(parseMeeting({ data: { joinUrl: "javascript:alert(1)" } })).toBeUndefined();
    expect(parseMeeting({ data: {} })).toBeUndefined();
    expect(parseMeeting("<html>")).toBeUndefined();
    expect(isZoomAuthError(401)).toBe(true);
    expect(isZoomAuthError(200, '{"code":"403"}')).toBe(true);
    expect(isZoomAuthError(500, "oops")).toBe(false);
    expect(zoomMeetingForm(" t ")).toEqual({ accessToken: "t" });
    expect(() => zoomMeetingForm("")).toThrow();
  });

  it("caps: flag and server config both required; flow never verified", () => {
    expect(zoomEnabled({ UBM_ZOOM: "1" })).toBe(true);
    expect(zoomEnabled({})).toBe(false);
    expect(zoomCaps({ env: {}, config: { use: true }, connected: true })).toEqual({
      enabled: false, configured: true, flowVerified: false, connected: false, reason: ZOOM_DISABLED_TEXT,
    });
    expect(zoomCaps({ env: { UBM_ZOOM: "1" }, config: { use: false }, connected: false }).enabled).toBe(false);
    expect(zoomCaps({ env: { UBM_ZOOM: "1" }, config: { use: true }, connected: true })).toEqual({
      enabled: true, configured: true, flowVerified: false, connected: true,
    });
  });

  it("maskSecrets hides the accessToken form value", () => {
    expect(maskSecrets("accessToken=abc.def&x=1")).not.toContain("abc.def");
  });
});

describe("zoom client", () => {
  it("reads config with a GET to baseconfig", async () => {
    const fetchMock = vi.fn(async () => reply(JSON.stringify({ data: { useZoomChat: true, zoomClientId: "cid" } })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(client().fetchZoomConfig()).resolves.toEqual({ use: true, clientId: "cid" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://daou.example${ZOOM_CONFIG_PATH}`);
    expect(init.method).toBe("GET");
  });

  it("refuses to create a meeting without UBM_ZOOM=1", async () => {
    vi.stubEnv("UBM_ZOOM", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(client().createZoomMeeting("tok")).rejects.toThrow(ZOOM_DISABLED_TEXT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs the form and returns joinUrl, or 'auth' on 401", async () => {
    vi.stubEnv("UBM_ZOOM", "1");
    const fetchMock = vi.fn(async () => reply(JSON.stringify({ data: { joinUrl: "https://zoom.us/j/1" } })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(client().createZoomMeeting("tok")).resolves.toEqual({ joinUrl: "https://zoom.us/j/1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://daou.example${ZOOM_MEETING_PATH}`);
    expect(init.method).toBe("POST");
    expect(String(init.body)).toBe("accessToken=tok");

    vi.stubGlobal("fetch", vi.fn(async () => reply(JSON.stringify({ code: "401", message: "invalid token" }))));
    await expect(client().createZoomMeeting("tok")).resolves.toBe("auth");
  });
});

describe("zoom XMPP stanza", () => {
  it("emits zoomToken and never treats it as a chat message", () => {
    const core = new MessengerCore("https://daou.example");
    core.client.user = { id: 42, repId: 42, name: "나", loginId: "me", companyId: 1 };
    const tokens: unknown[] = [];
    const messages: unknown[] = [];
    core.on("zoomToken", (t) => tokens.push(t));
    core.on("message", (m) => messages.push(m));
    (core as any).onBody({ actiontype: "zoom", type: "chat", message: '{"access_token":"AT"}' });
    expect(tokens).toEqual([{ accessToken: "AT" }]);
    expect(messages).toEqual([]);
  });
});
