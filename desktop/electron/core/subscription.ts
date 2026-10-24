/**
 * Core subscription stub. No payment, no store, no license verification.
 *
 * Dawer Free stays off: `hasCoreLicense` always returns false, so
 * `coreFeaturesEnabled` is true only for the ubion flavor. A later verifier
 * can replace `hasCoreLicense` without changing the call sites.
 *
 * A future key is bound to one tenant host. Parsing a key does not enable
 * reactions, polls, status, or 유비온봇.
 */
import type { Flavor } from "./flavor";
import { canonicalTenantHost, tenantHost } from "./tenant";

export type SubscriptionKey = {
  v: 1;
  tenantHost: string;
  tier: "core";
  /** Opaque id. Not a receipt and not checked against a payment provider. */
  keyId: string;
};

const KEY_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function parseSubscriptionKey(raw: unknown): SubscriptionKey | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || o.tier !== "core") return null;
  const host = typeof o.tenantHost === "string" ? canonicalTenantHost(o.tenantHost) : "";
  if (!host || typeof o.keyId !== "string" || !KEY_ID_RE.test(o.keyId)) return null;
  return { v: 1, tenantHost: host, tier: "core", keyId: o.keyId };
}

/** The key for this server, or null when the host does not match. Not an entitlement. */
export function subscriptionForTenant(serverUrl: string, rawKey: unknown): SubscriptionKey | null {
  const host = tenantHost(serverUrl);
  const key = parseSubscriptionKey(rawKey);
  if (!host || !key || key.tenantHost !== host) return null;
  return key;
}

/**
 * Always false in this build. `serverUrl` and `rawKey` are the future inputs
 * (tenant host + subscription record). A matching shape is still not a license.
 */
export function hasCoreLicense(serverUrl?: string, rawKey?: unknown): boolean {
  void subscriptionForTenant(serverUrl ?? "", rawKey);
  return false;
}

/** ubion keeps today's bot features. Every other flavor waits on a real license. */
export function coreFeaturesEnabled(flavor: Flavor, license: boolean = hasCoreLicense()): boolean {
  return flavor === "ubion" || license === true;
}

/**
 * Header value for X-UBM-Tenant. UBION's deployed bot must not see the header.
 * Other flavors send the Daou host only when Core is actually licensed.
 */
export function botTenantHeader(flavor: Flavor, license: boolean, serverUrl: string): string {
  if (flavor === "ubion" || license !== true) return "";
  return tenantHost(serverUrl);
}

/**
 * Bot API origin. Generic ignores `UBM_BOT_API_URL` until Core is licensed, and
 * even then it does not fall back to bot.ubion.global.
 */
export function botApiBaseUrl(input: {
  flavor: Flavor;
  license?: boolean;
  envUrl?: string;
  defaultBotApiUrl?: string;
}): string {
  if (!coreFeaturesEnabled(input.flavor, input.license ?? hasCoreLicense())) return "";
  const env = input.envUrl ?? "";
  if (input.flavor === "ubion") return (env || input.defaultBotApiUrl || "").replace(/\/$/, "");
  return (env || "").replace(/\/$/, "");
}
