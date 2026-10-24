/**
 * Tenant id for a future multi-tenant bot. The tenant is the Daou server host
 * (`https://coco.ubion.co.kr` → `coco.ubion.co.kr`), not a company name.
 *
 * This repository has no bot server. UBION talks to the external single-tenant
 * service at bot.ubion.global and does not send X-UBM-Tenant. A future server
 * (that service, or a replacement) should isolate stored rows with these keys
 * before it looks up roomSeq or userSeq:
 *
 * - reactions / polls: `tenantRoomKey` → `host+roomSeq` (example `coco.ubion.co.kr+27673`)
 * - status text: `tenantUserKey` → `host+userSeq`, in the status table only
 *   (the same digits are a different record from a room)
 * - per-room bot settings: `tenantRoomSettingsKey` → `host+room:<seq>`
 *
 * DaouOffice cookies stay on the tenant. Our server keeps using the ubt1 DM
 * challenge token (`X-UBM-Session`). Never accept a Daou cookie as proof.
 */

export const TENANT_HEADER = "X-UBM-Tenant";

const HOST_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/;

/** Lowercase host[:port], or "" when the value is not a tenant host. */
export function canonicalTenantHost(raw: unknown): string {
  const host = String(raw ?? "").trim().toLowerCase();
  if (!host || host.includes("+") || !HOST_RE.test(host)) return "";
  const port = host.match(/:(\d+)$/);
  if (port && Number(port[1]) > 65535) return "";
  return host;
}

/**
 * Tenant id from a Daou server URL. Path, userinfo, and fragment are ignored.
 * An empty or non-http(s) URL yields "" (it is not rewritten to a company host).
 */
export function tenantHost(serverUrl: unknown): string {
  const raw = String(serverUrl ?? "").trim();
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  return canonicalTenantHost(url.host);
}

function requireHost(host: string): string {
  const h = canonicalTenantHost(host);
  if (!h) throw new Error("tenant host가 올바르지 않습니다");
  return h;
}

function requireSeq(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}가 올바르지 않습니다`);
  return value;
}

/** Room-scoped bot data (reactions, polls): `host+roomSeq`. */
export function tenantRoomKey(host: string, roomSeq: number): string {
  return `${requireHost(host)}+${requireSeq(roomSeq, "roomSeq")}`;
}

export function parseTenantRoomKey(key: string): { host: string; roomSeq: number } | null {
  const raw = String(key ?? "");
  const i = raw.lastIndexOf("+");
  if (i <= 0) return null;
  const host = canonicalTenantHost(raw.slice(0, i));
  const seqText = raw.slice(i + 1);
  const roomSeq = Number(seqText);
  if (!host || !/^\d+$/.test(seqText) || !Number.isSafeInteger(roomSeq) || roomSeq <= 0) return null;
  return { host, roomSeq };
}

/**
 * Status text, status table only: `host+userSeq`.
 * Do not store this in the room table — user 42 and room 42 would collide.
 */
export function tenantUserKey(host: string, userSeq: number): string {
  return `${requireHost(host)}+${requireSeq(userSeq, "userSeq")}`;
}

/** Bot room-settings record. `roomId` is the client key `room:<seq>`. */
export function tenantRoomSettingsKey(host: string, roomId: string): string {
  const id = String(roomId ?? "").trim();
  if (!/^room:\d+$/.test(id)) throw new Error("roomId가 올바르지 않습니다");
  return `${requireHost(host)}+${id}`;
}

export function resolveTenantHeader(getTenantHost?: () => string): string {
  if (!getTenantHost) return "";
  try {
    const value = getTenantHost();
    return typeof value === "string" ? canonicalTenantHost(value) : "";
  } catch {
    return "";
  }
}

/**
 * Auth headers for our bot. `X-UBM-Tenant` is added only when a tenant host is
 * present, so the deployed UBION bot keeps the two-header request it has today.
 * Session is the ubt1 token, never a DaouOffice cookie.
 */
export function ubmRequestHeaders(userSeq: number, session: string, tenant = ""): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-UBM-User-Seq": String(userSeq),
    "X-UBM-Session": session,
  };
  const host = canonicalTenantHost(tenant);
  if (host) headers[TENANT_HEADER] = host;
  return headers;
}
