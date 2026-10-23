/**
 * Zoom 연동 (DaouOffice 3.5.42 renderer bundle).
 * - Config: GET /api/mobile/baseconfig → data.useZoomChat / data.zoomClientId, stored by the original as
 *   videoChatOption = { isZoomSupported, zoomInfo: { clientId, use, token } }.
 * - OAuth: https://zoom.us/oauth/authorize?response_type=code&client_id=..&redirect_uri={server}/zoom/accesstoken&state=btoa(JSON{resource,userSeq,roomSeq}).
 *   The redirect lands on the Daou server, which exchanges the code; the token then arrives over XMPP as a
 *   stanza with actiontype "zoom" whose message is JSON { access_token, refresh_token, expires_in }.
 *   UNVERIFIED end to end: nobody has captured one round trip against coco.ubion yet.
 * - Meeting: POST /api/zoom/meetings, form accessToken=… → { data: { joinUrl } }. 401/403 → re-authorize.
 * Tokens are secrets: keep them in memory only and never log them.
 */

export const ZOOM_AUTHORIZE_URL = "https://zoom.us/oauth/authorize";
export const ZOOM_REDIRECT_PATH = "/zoom/accesstoken";
export const ZOOM_CONFIG_PATH = "/api/mobile/baseconfig";
export const ZOOM_MEETING_PATH = "/api/zoom/meetings";
export const ZOOM_MEETING_METHOD = "POST";
/** Documented fallback only: the original uses it when the server config has no zoomClientId. */
export const ZOOM_DEFAULT_CLIENT_ID = "CEnRkioLQ9iZl1gjLEW79g";
export const ZOOM_DISABLED_TEXT = "Zoom 연동은 아직 지원되지 않습니다";

export type ZoomConfig = { use: boolean; clientId?: string };
export type ZoomClientId = { clientId: string; source: "param" | "config" | "default" };
export type ZoomToken = { accessToken: string; refreshToken?: string; expiresIn?: number };
export type ZoomRedirect = { accessToken?: string; code?: string; error?: string };
export type ZoomMeeting = { joinUrl: string };
export type ZoomCaps = {
  /** UBM_ZOOM=1 and the server reports Zoom as configured. The UI shows the button only when true. */
  enabled: boolean;
  configured: boolean;
  /** The OAuth round trip has never been captured; always false until it is. */
  flowVerified: false;
  connected: boolean;
  reason?: string;
};

export function zoomEnabled(env: Record<string, string | undefined>): boolean {
  return env.UBM_ZOOM === "1";
}

const CLIENT_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

function cleanClientId(value: unknown): string | undefined {
  const s = typeof value === "string" ? value.trim() : "";
  return CLIENT_ID_RE.test(s) ? s : undefined;
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || (typeof value === "string" && /^(true|y|yes|1)$/i.test(value.trim()));
}

/**
 * Accepts the baseconfig response ({data:{useZoomChat,zoomClientId}}), its data object, or a stored
 * videoChatOption ({isZoomSupported, zoomInfo:{clientId,use}}). Returns undefined when nothing Zoom-related is present.
 */
export function parseZoomConfig(raw: unknown): ZoomConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const top = raw as Record<string, any>;
  const data = top.data && typeof top.data === "object" ? top.data : top;
  const vco = [data.videoChatOption, top.videoChatOption, data].find(
    (v) => v && typeof v === "object" && (v.zoomInfo || "isZoomSupported" in v)
  ) as Record<string, any> | undefined;
  const info = vco?.zoomInfo && typeof vco.zoomInfo === "object" ? vco.zoomInfo : {};
  const hasFlag = "useZoomChat" in data || (vco != null && ("isZoomSupported" in vco || "use" in info));
  const clientId = cleanClientId(data.zoomClientId) ?? cleanClientId(info.clientId);
  if (!hasFlag && !clientId) return undefined;
  const use = "useZoomChat" in data ? truthy(data.useZoomChat) : truthy(vco?.isZoomSupported) || truthy(info.use);
  return clientId ? { use, clientId } : { use };
}

/** param (explicit override) > server config > documented default (only when the config carries no client id). */
export function resolveZoomClientId(config: ZoomConfig | undefined | null, param?: unknown): ZoomClientId {
  const p = cleanClientId(param);
  if (p) return { clientId: p, source: "param" };
  const c = cleanClientId(config?.clientId);
  if (c) return { clientId: c, source: "config" };
  return { clientId: ZOOM_DEFAULT_CLIENT_ID, source: "default" };
}

export function zoomRedirectUri(baseUrl: string): string {
  const u = new URL(baseUrl);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("서버 주소가 올바르지 않습니다");
  return `${u.origin}${ZOOM_REDIRECT_PATH}`;
}

/** Same as the original btoa(JSON.stringify({resource,userSeq,roomSeq})). */
export function zoomState(s: { resource: string; userSeq: number; roomSeq: number }): string {
  return btoa(JSON.stringify({ resource: String(s.resource).replace(/[^\x20-\x7e]/g, ""), userSeq: s.userSeq, roomSeq: s.roomSeq }));
}

export function zoomAuthorizeUrl(clientId: string, redirectUri: string, state?: string): string {
  const id = cleanClientId(clientId);
  if (!id) throw new Error("Zoom client id가 올바르지 않습니다");
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== "https:" && redirect.protocol !== "http:") throw new Error("redirect URI가 올바르지 않습니다");
  let url = `${ZOOM_AUTHORIZE_URL}?response_type=code&client_id=${encodeURIComponent(id)}&redirect_uri=${encodeURIComponent(redirect.toString())}`;
  if (state) url += `&state=${encodeURIComponent(state)}`;
  return url;
}

/**
 * UNVERIFIED, best effort: when the OAuth window reaches the redirect URI, pull a token / code / error
 * from its query or fragment. Returns null for any other URL.
 */
export function extractZoomRedirect(url: string, redirectUri: string): ZoomRedirect | null {
  let u: URL;
  let r: URL;
  try {
    u = new URL(url);
    r = new URL(redirectUri);
  } catch {
    return null;
  }
  if (u.origin !== r.origin || u.pathname.replace(/\/$/, "") !== r.pathname.replace(/\/$/, "")) return null;
  const params = new URLSearchParams(u.search);
  new URLSearchParams(u.hash.replace(/^#/, "")).forEach((v, k) => { if (!params.has(k)) params.set(k, v); });
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = params.get(k);
      if (v && v.trim()) return v.trim();
    }
    return undefined;
  };
  const out: ZoomRedirect = {};
  const accessToken = pick("access_token", "accessToken");
  const code = pick("code");
  const error = pick("error_description", "error");
  if (accessToken) out.accessToken = accessToken;
  if (code) out.code = code;
  if (error) out.error = error;
  return out;
}

/** XMPP stanza with actiontype "zoom": message is (backslash-escaped) JSON { access_token, refresh_token, expires_in }. */
export function parseZoomTokenMessage(raw: unknown): ZoomToken | undefined {
  let value: any = raw;
  if (value && typeof value === "object" && "message" in value) value = (value as any).message;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value.replace(/\\/g, ""));
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const accessToken = typeof (value.access_token ?? value.accessToken) === "string" ? String(value.access_token ?? value.accessToken).trim() : "";
  if (!accessToken) return undefined;
  const token: ZoomToken = { accessToken };
  const refresh = value.refresh_token ?? value.refreshToken;
  if (typeof refresh === "string" && refresh) token.refreshToken = refresh;
  const expires = Number(value.expires_in ?? value.expiresIn);
  if (Number.isFinite(expires) && expires > 0) token.expiresIn = expires;
  return token;
}

export function zoomMeetingForm(accessToken: unknown): { accessToken: string } {
  const t = typeof accessToken === "string" ? accessToken.trim() : "";
  if (!t) throw new Error("Zoom 연결이 필요합니다");
  return { accessToken: t };
}

/** { data: { joinUrl } } or { joinUrl }; only http(s) URLs are accepted (it is pasted into the composer). */
export function parseMeeting(raw: unknown): ZoomMeeting | undefined {
  let value: any = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const data = value.data && typeof value.data === "object" ? value.data : value;
  const joinUrl = String(data.joinUrl ?? data.join_url ?? "").trim();
  if (!joinUrl) return undefined;
  try {
    const u = new URL(joinUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  } catch {
    return undefined;
  }
  return { joinUrl };
}

/** Zoom answered "token invalid/expired": the original re-opens the authorize page. */
export function isZoomAuthError(status: number, raw?: unknown): boolean {
  if (status === 401 || status === 403) return true;
  let body: any = raw;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return false;
    }
  }
  const code = body && typeof body === "object" ? String(body.code ?? "") : "";
  return code === "401" || code === "403";
}

export function zoomCaps(o: { env: Record<string, string | undefined>; config: ZoomConfig | undefined | null; connected: boolean }): ZoomCaps {
  const flag = zoomEnabled(o.env);
  const configured = !!o.config?.use;
  const caps: ZoomCaps = { enabled: flag && configured, configured, flowVerified: false, connected: flag && o.connected };
  if (!flag) caps.reason = ZOOM_DISABLED_TEXT;
  else if (!configured) caps.reason = "서버에 Zoom 연동이 설정되어 있지 않습니다";
  return caps;
}
