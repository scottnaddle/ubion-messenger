/**
 * Build flavor: ubion (company desktop) or generic (다워 / Dawer).
 *
 * UBM_FLAVOR is read when electron-vite starts and baked in as __UBM_FLAVOR__.
 * Unpackaged scripts and vitest have no bake, so they use process.env (default ubion).
 * A packaged app keeps the flavor it was built with.
 */
import profilesJson from "../flavor-profiles.json";
import { tk } from "../../src/lib/i18n-core";

export const FLAVORS = ["ubion", "generic"] as const;
export type Flavor = (typeof FLAVORS)[number];

export type FlavorProfile = {
  id: Flavor;
  /** Installer / OS name (ASCII). */
  productName: string;
  /** Korean UI name. */
  productNameKo: string;
  logoMark: string;
  /** Extra class on .logo-mark. Empty for the company flavor. */
  logoClass: string;
  appId: string;
  appIdDev: string;
  /** Directory under appData. Distinct so the two flavors do not share settings. */
  userDataDir: string;
  defaultServerUrl: string;
  /** Login shows the server field immediately (blank is a valid stored default). */
  serverUrlFirstClass: boolean;
  /** flex.team HR integration and @company flex auto-login. */
  flex: boolean;
  /** Appended when the portal id has no @. null = never invent a company email. */
  flexEmailDomain: string | null;
  /** Our bot host. Empty on generic so the client does not call bot.ubion.global. */
  defaultBotApiUrl: string;
  /**
   * Flavor default for reactions, polls, status server, and 유비온봇.
   * The runtime gate is `coreFeaturesEnabled` (`flavor === "ubion" || hasCoreLicense`).
   * `hasCoreLicense` is false until a verifier exists, so generic stays off.
   */
  enhancedServer: boolean;
  /** GitHub update feed. Generic has none yet. */
  updates: boolean;
  /** One-line Korean disclaimer. Empty on the company flavor. */
  unofficialNotice: string;
  artifactPrefix: string;
  /** Directory under resources/. Empty keeps the UBION icon set at the resources root. */
  iconDir: string;
};

const PROFILES = profilesJson as Record<Flavor, FlavorProfile>;

declare const __UBM_FLAVOR__: string | undefined;

function bakedFlavor(): string {
  try {
    return typeof __UBM_FLAVOR__ === "string" ? __UBM_FLAVOR__ : "";
  } catch {
    return "";
  }
}

function readProcessEnv(key: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = proc?.env?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Unknown / empty values stay ubion so existing builds do not change. "dawer" is an alias of generic. */
export function normalizeFlavor(raw: unknown): Flavor {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "generic" || v === "dawer") return "generic";
  return "ubion";
}

/**
 * Explicit `env.UBM_FLAVOR` wins (tests). Otherwise the baked build flavor,
 * otherwise the process environment. Default ubion.
 */
export function resolveFlavor(env?: Record<string, string | undefined>): Flavor {
  if (env && Object.prototype.hasOwnProperty.call(env, "UBM_FLAVOR")) return normalizeFlavor(env.UBM_FLAVOR);
  const baked = bakedFlavor();
  if (baked) return normalizeFlavor(baked);
  return normalizeFlavor(readProcessEnv("UBM_FLAVOR"));
}

export function flavorProfile(flavor?: Flavor): FlavorProfile {
  return PROFILES[flavor ?? resolveFlavor()];
}

/** Korean UI uses productNameKo (다워). Other languages use the English product name (Dawer). */
export function flavorLabel(profile: FlavorProfile, lang: string): string {
  return lang === "ko" ? profile.productNameKo : profile.productName;
}

export function flavorAppId(profile: FlavorProfile, dev: boolean): string {
  return dev ? profile.appIdDev : profile.appId;
}

/** Icon file relative to resources/. UBION stays at the root; Dawer is resources/dawer/. */
export function flavorIconName(profile: FlavorProfile, file: string): string {
  const dir = profile.iconDir.trim().replace(/^\/+|\/+$/g, "");
  return dir ? `${dir}/${file}` : file;
}

export function flavorDefaults(profile: FlavorProfile = flavorProfile()): {
  serverUrl: string;
  flexAutoLogin: boolean;
  autoUpdate: boolean;
} {
  return {
    serverUrl: profile.defaultServerUrl,
    flexAutoLogin: profile.flex,
    autoUpdate: profile.updates,
  };
}

export const SERVER_URL_ERROR = tk("서버 주소는 https:// 로 시작해야 합니다");

/** Trim and require http(s). Empty is not rewritten to a company host. */
export function normalizeServerUrl(raw: unknown): string {
  const serverUrl = String(raw ?? "").trim().replace(/\/$/, "");
  if (!/^https?:\/\//i.test(serverUrl)) throw new Error(SERVER_URL_ERROR);
  return serverUrl;
}
