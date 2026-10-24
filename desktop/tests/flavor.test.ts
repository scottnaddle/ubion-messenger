import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaouClient } from "../electron/core/daou-client";
import {
  flavorAppId, flavorDefaults, flavorIconName, flavorLabel, flavorProfile, normalizeFlavor, normalizeServerUrl, resolveFlavor, SERVER_URL_ERROR,
} from "../electron/core/flavor";
import { navOrder } from "../src/nav";
import { railShortcut } from "../src/rail-tooltip";

const require = createRequire(import.meta.url);
const { buildConfig, publishConfig } = require("../scripts/flavor-build.cjs") as {
  publishConfig: (profile: { updates: boolean; updateOwner?: string; updateRepo?: string }) => { repo?: string }[] | null;
  buildConfig: (env?: Record<string, string | undefined>) => {
    appId: string;
    productName: string;
    publish?: { repo?: string }[];
    extraMetadata?: { author?: string };
    extraResources?: { from: string; to: string }[];
    nsis: { shortcutName: string };
    mac: { artifactName: string; icon: string };
    win: { icon: string };
    linux: { icon: string };
  };
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("UBM_FLAVOR", () => {
  it("defaults to ubion, including unknown values", () => {
    expect(normalizeFlavor(undefined)).toBe("ubion");
    expect(normalizeFlavor("")).toBe("ubion");
    expect(normalizeFlavor("nope")).toBe("ubion");
    expect(resolveFlavor({})).toBe("ubion");
    expect(flavorProfile().id).toBe("ubion");
    expect(flavorProfile().productName).toBe("UBION Messenger");
    expect(flavorDefaults().serverUrl).toBe("https://coco.ubion.co.kr");
    expect(flavorDefaults().flexAutoLogin).toBe(true);
    expect(flavorDefaults().autoUpdate).toBe(true);
  });

  it("treats generic and dawer as the Dawer flavor", () => {
    for (const raw of ["generic", "dawer", " Dawer "]) {
      const id = normalizeFlavor(raw);
      const p = flavorProfile(id);
      expect(p.id).toBe("generic");
      expect(p.productName).toBe("Dawer");
      expect(p.productNameKo).toBe("다워");
      expect(p.appId).toBe("global.ubion.dawer");
      expect(p.appIdDev).toBe("global.ubion.dawer.dev");
      expect(p.defaultServerUrl).toBe("");
      expect(p.serverUrlFirstClass).toBe(true);
      expect(p.flex).toBe(false);
      expect(p.flexEmailDomain).toBeNull();
      expect(p.defaultBotApiUrl).toBe("");
      expect(p.enhancedServer).toBe(false);
      expect(p.updates).toBe(false);
      expect(p.updateOwner).toBe("");
      expect(p.updateRepo).toBe("");
      expect(p.unofficialNotice).toBe("비공식 클라이언트");
      expect(p.userDataDir).toBe("Dawer");
      expect(p.iconDir).toBe("dawer");
      expect(flavorIconName(p, "icon.png")).toBe("dawer/icon.png");
    }
    expect(flavorLabel(flavorProfile("generic"), "ko")).toBe("다워");
    expect(flavorLabel(flavorProfile("generic"), "en")).toBe("Dawer");
    expect(flavorLabel(flavorProfile("ubion"), "ko")).toBe("UBION Messenger");
    expect(flavorProfile("ubion").iconDir).toBe("");
    expect(flavorIconName(flavorProfile("ubion"), "icon.png")).toBe("icon.png");
    expect(flavorAppId(flavorProfile("ubion"), false)).toBe("global.ubion.messenger");
    expect(flavorAppId(flavorProfile("ubion"), true)).toBe("global.ubion.messenger.dev");
    expect(flavorDefaults(flavorProfile("generic"))).toEqual({ serverUrl: "", flexAutoLogin: false, autoUpdate: false });
  });

  it("reads UBM_FLAVOR from the environment when nothing is baked", () => {
    vi.stubEnv("UBM_FLAVOR", "generic");
    expect(resolveFlavor()).toBe("generic");
    expect(flavorProfile().flex).toBe(false);
    expect(navOrder(flavorProfile().flex)).not.toContain("flex");
    expect(railShortcut("people", "darwin", navOrder(false))).toBe("⌘4/⌘N");
  });

  it("keeps a blank server address instead of falling back to the company host", () => {
    expect(() => normalizeServerUrl("")).toThrow(SERVER_URL_ERROR);
    expect(() => normalizeServerUrl("coco.ubion.co.kr")).toThrow(SERVER_URL_ERROR);
    expect(normalizeServerUrl("https://tenant.example/")).toBe("https://tenant.example");
    expect(new DaouClient().baseUrl).toBe("https://coco.ubion.co.kr");
    expect(new DaouClient("").baseUrl).toBe("");
    vi.stubEnv("UBM_FLAVOR", "generic");
    expect(flavorProfile().defaultServerUrl).toBe("");
  });
});

describe("electron-builder flavor", () => {
  it("leaves the ubion installer identity unchanged", () => {
    const cfg = buildConfig({});
    expect(cfg.appId).toBe("global.ubion.messenger");
    expect(cfg.productName).toBe("UBION Messenger");
    expect(cfg.nsis.shortcutName).toBe("UBION Messenger");
    expect(cfg.mac.artifactName).toBe("UBION-Messenger-${version}-${arch}-mac.${ext}");
    expect(cfg.publish?.[0]?.repo).toBe("ubion-messenger-releases");
    expect(cfg.publish).toEqual(publishConfig(flavorProfile("ubion")));
    expect(cfg.mac.icon).toBe("resources/icon.icns");
    expect(cfg.win.icon).toBe("resources/icon.ico");
    expect(cfg.linux.icon).toBe("resources/icon-1024.png");
    expect(cfg.extraResources?.[0]?.from).toBe("resources");
  });

  it("ships Dawer under its own app id and does not publish to the ubion feed", () => {
    const cfg = buildConfig({ UBM_FLAVOR: "generic" });
    expect(cfg.appId).toBe("global.ubion.dawer");
    expect(cfg.productName).toBe("Dawer");
    expect(cfg.nsis.shortcutName).toBe("Dawer");
    expect(cfg.mac.artifactName).toBe("Dawer-${version}-${arch}-mac.${ext}");
    expect(cfg.publish).toBeUndefined();
    expect(publishConfig(flavorProfile("generic"))).toBeNull();
    expect(publishConfig({ updates: true, updateOwner: "scottnaddle", updateRepo: "dawer-releases" })).toEqual([
      { provider: "github", owner: "scottnaddle", repo: "dawer-releases", releaseType: "release" },
    ]);
    expect(cfg.extraMetadata?.author).toBe("Dawer");
    expect(cfg.mac.icon).toBe("resources/dawer/icon.icns");
    expect(cfg.win.icon).toBe("resources/dawer/icon.ico");
    expect(cfg.linux.icon).toBe("resources/dawer/icon-1024.png");
    expect(cfg.extraResources?.[0]).toEqual({
      from: "resources/dawer",
      to: "resources/dawer",
      filter: ["*.png", "*.ico", "*.icns"],
    });
    const dawer = path.join(__dirname, "../resources/dawer");
    const png = (name: string) => {
      const buf = fs.readFileSync(path.join(dawer, name));
      expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      return { buf, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    };
    expect(png("icon.png")).toMatchObject({ w: 512, h: 512 });
    expect(png("icon-1024.png")).toMatchObject({ w: 1024, h: 1024 });
    expect(png("icon-mac.png")).toMatchObject({ w: 1024, h: 1024 });
    expect(png("tray.png")).toMatchObject({ w: 16, h: 16 });
    expect(png("trayTemplate.png")).toMatchObject({ w: 16, h: 16 });
    expect(fs.readFileSync(path.join(dawer, "icon.ico")).subarray(0, 4).toString("hex")).toBe("00000100");
    expect(fs.readFileSync(path.join(dawer, "icon.icns")).subarray(0, 4).toString()).toBe("icns");
    expect(Buffer.compare(png("icon.png").buf, fs.readFileSync(path.join(__dirname, "../resources/icon.png")))).not.toBe(0);
    expect(buildConfig({ UBM_FLAVOR: "dawer", UBM_APP_CHANNEL: "dev" }).appId).toBe("global.ubion.dawer.dev");
    expect(buildConfig({ UBM_APP_CHANNEL: "dev" }).appId).toBe("global.ubion.messenger.dev");
  });
});
