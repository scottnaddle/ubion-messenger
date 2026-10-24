import { describe, expect, it } from "vitest";
import { flavorProfile } from "../electron/core/flavor";
import {
  botApiBaseUrl, botTenantHeader, coreFeaturesEnabled, hasCoreLicense, parseSubscriptionKey, subscriptionForTenant,
} from "../electron/core/subscription";
import {
  parseTenantRoomKey, tenantHost, tenantRoomKey, tenantRoomSettingsKey, tenantUserKey, ubmRequestHeaders,
} from "../electron/core/tenant";

const coreKey = {
  v: 1 as const,
  tenantHost: "tenant.example",
  tier: "core" as const,
  keyId: "core_test_key",
};

describe("tenant host", () => {
  it("keys a tenant by the Daou server host, not the path", () => {
    expect(tenantHost("https://coco.ubion.co.kr")).toBe("coco.ubion.co.kr");
    expect(tenantHost("HTTPS://Tenant.Example:8443/daou/login")).toBe("tenant.example:8443");
    expect(tenantHost("https://user:secret@tenant.example/x")).toBe("tenant.example");
    expect(tenantHost("")).toBe("");
    expect(tenantHost("coco.ubion.co.kr")).toBe("");
    expect(tenantHost("file:///tmp/x")).toBe("");
  });

  it("isolates room data as host+roomSeq", () => {
    expect(tenantRoomKey("coco.ubion.co.kr", 27673)).toBe("coco.ubion.co.kr+27673");
    expect(tenantRoomKey("tenant.example", 27673)).toBe("tenant.example+27673");
    expect(tenantRoomKey("tenant.example", 27673)).not.toBe(tenantRoomKey("other.example", 27673));
    expect(parseTenantRoomKey("tenant.example:8443+27673")).toEqual({ host: "tenant.example:8443", roomSeq: 27673 });
    expect(parseTenantRoomKey("not a key")).toBeNull();
    expect(parseTenantRoomKey("evil+1+2")).toBeNull();
  });

  it("keeps status and room settings in their own key shapes", () => {
    expect(tenantUserKey("tenant.example", 42)).toBe("tenant.example+42");
    expect(tenantRoomSettingsKey("tenant.example", "room:27673")).toBe("tenant.example+room:27673");
    expect(() => tenantRoomKey("bad host", 1)).toThrow(/tenant host/);
    expect(() => tenantRoomKey("tenant.example", 0)).toThrow(/roomSeq/);
    expect(() => tenantRoomSettingsKey("tenant.example", "27673")).toThrow(/roomId/);
  });

  it("adds X-UBM-Tenant only for a real host and never a cookie", () => {
    expect(ubmRequestHeaders(7, "ubt1.token")).toEqual({
      "Content-Type": "application/json",
      "X-UBM-User-Seq": "7",
      "X-UBM-Session": "ubt1.token",
    });
    expect(ubmRequestHeaders(7, "ubt1.token", "Tenant.Example")["X-UBM-Tenant"]).toBe("tenant.example");
    expect(ubmRequestHeaders(7, "ubt1.token", "not a host")["X-UBM-Tenant"]).toBeUndefined();
    expect(ubmRequestHeaders(7, "ubt1.token").Cookie).toBeUndefined();
  });
});

describe("Core license gate", () => {
  it("keeps Dawer Free off and ubion on while the license is false", () => {
    expect(hasCoreLicense()).toBe(false);
    expect(hasCoreLicense("https://tenant.example", coreKey)).toBe(false);
    expect(coreFeaturesEnabled("ubion")).toBe(true);
    expect(coreFeaturesEnabled("ubion", false)).toBe(true);
    expect(coreFeaturesEnabled("generic")).toBe(false);
    expect(coreFeaturesEnabled("generic", false)).toBe(false);
    expect(coreFeaturesEnabled("generic", true)).toBe(true);
    expect(flavorProfile("generic").enhancedServer).toBe(false);
    expect(flavorProfile("ubion").enhancedServer).toBe(true);
  });

  it("parses a subscription key without treating it as paid", () => {
    expect(parseSubscriptionKey(coreKey)).toEqual(coreKey);
    expect(parseSubscriptionKey({ ...coreKey, tier: "pro" })).toBeNull();
    expect(parseSubscriptionKey({ ...coreKey, keyId: "short" })).toBeNull();
    expect(subscriptionForTenant("https://tenant.example/login", coreKey)?.tenantHost).toBe("tenant.example");
    expect(subscriptionForTenant("https://other.example", coreKey)).toBeNull();
    expect(hasCoreLicense("https://tenant.example", coreKey)).toBe(false);
  });

  it("does not point Dawer at bot.ubion.global", () => {
    const ubionDefault = flavorProfile("ubion").defaultBotApiUrl;
    expect(botApiBaseUrl({ flavor: "ubion", envUrl: "", defaultBotApiUrl: ubionDefault })).toBe("https://bot.ubion.global");
    expect(botApiBaseUrl({
      flavor: "ubion", envUrl: "https://bot.example/custom/", defaultBotApiUrl: ubionDefault,
    })).toBe("https://bot.example/custom");
    expect(botApiBaseUrl({
      flavor: "generic", envUrl: "https://bot.example", defaultBotApiUrl: ubionDefault,
    })).toBe("");
    expect(botApiBaseUrl({
      flavor: "generic", license: true, envUrl: "https://bot.example/", defaultBotApiUrl: ubionDefault,
    })).toBe("https://bot.example");
    expect(botApiBaseUrl({
      flavor: "generic", license: true, envUrl: "", defaultBotApiUrl: ubionDefault,
    })).toBe("");
  });

  it("sends the tenant header only for a licensed non-ubion host", () => {
    expect(botTenantHeader("ubion", false, "https://coco.ubion.co.kr")).toBe("");
    expect(botTenantHeader("ubion", true, "https://coco.ubion.co.kr")).toBe("");
    expect(botTenantHeader("generic", false, "https://tenant.example")).toBe("");
    expect(botTenantHeader("generic", true, "https://tenant.example/daou")).toBe("tenant.example");
    expect(botTenantHeader("generic", true, "")).toBe("");
  });
});
