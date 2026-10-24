import { describe, expect, it, vi } from "vitest";
import { flavorProfile } from "../electron/core/flavor";
import { checkMacUpdate, compareVersions, parseLatestYml, RELEASES_REPO, resolveUpdateFeed } from "../electron/core/update-check";

const YML = `version: 1.0.3
files:
  - url: UBION-Messenger-1.0.3-arm64-mac.zip
    sha512: abc
    size: 1
  - url: UBION-Messenger-1.0.3-x64-mac.zip
    sha512: def
    size: 2
path: UBION-Messenger-1.0.3-arm64-mac.zip
sha512: abc
releaseDate: '2026-10-22T02:40:00.000Z'
`;

describe("update check", () => {
  it("compares versions", () => {
    expect(compareVersions("1.0.3", "1.0.2")).toBe(1);
    expect(compareVersions("v1.0.2", "1.0.2")).toBe(0);
    expect(compareVersions("1.0.10", "1.0.9")).toBe(1);
    expect(compareVersions("1.1", "1.0.9")).toBe(1);
  });
  it("parses latest-mac.yml", () => {
    const p = parseLatestYml(YML);
    expect(p.version).toBe("1.0.3");
    expect(p.files).toHaveLength(2);
    expect(p.releaseDate).toBe("2026-10-22T02:40:00.000Z");
  });
  const fake = (status: number, body = YML) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  it("1.0.2 sees 1.0.3 with arch-specific dmg", async () => {
    const u = await checkMacUpdate("1.0.2", "arm64", fake(200));
    expect(u?.version).toBe("1.0.3");
    expect(u?.dmgUrl).toBe("https://github.com/scottnaddle/ubion-messenger-releases/releases/download/v1.0.3/UBION-Messenger-1.0.3-arm64.dmg");
    expect((await checkMacUpdate("1.0.2", "x64", fake(200)))?.dmgUrl).toMatch(/1\.0\.3-x64\.dmg$/);
  });
  it("no update when current or newer, none when no release", async () => {
    expect(await checkMacUpdate("1.0.3", "arm64", fake(200))).toBeNull();
    expect(await checkMacUpdate("1.0.4", "arm64", fake(200))).toBeNull();
    expect(await checkMacUpdate("1.0.2", "arm64", fake(404, ""))).toBeNull();
  });

  it("keeps the ubion feed and gives Dawer no URL", () => {
    const ubion = flavorProfile("ubion");
    expect(resolveUpdateFeed(ubion)).toEqual({
      owner: "scottnaddle",
      repo: RELEASES_REPO,
      artifactPrefix: "UBION-Messenger",
    });
    expect(resolveUpdateFeed(flavorProfile("generic"))).toBeNull();
  });

  it("does not call the network when the feed is empty", async () => {
    const fetch = vi.fn();
    expect(await checkMacUpdate("1.0.2", "arm64", fetch as unknown as typeof globalThis.fetch, null)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a future dawer-releases feed is not the ubion repo", async () => {
    const fetch = vi.fn(async () => new Response(YML, { status: 200 }));
    const feed = { owner: "scottnaddle", repo: "dawer-releases", artifactPrefix: "Dawer" };
    const u = await checkMacUpdate("1.0.2", "arm64", fetch as unknown as typeof globalThis.fetch, feed);
    expect(fetch).toHaveBeenCalledWith(
      "https://github.com/scottnaddle/dawer-releases/releases/latest/download/latest-mac.yml",
      expect.any(Object),
    );
    expect(u?.dmgUrl).toBe("https://github.com/scottnaddle/dawer-releases/releases/download/v1.0.3/Dawer-1.0.3-arm64.dmg");
    expect(u?.pageUrl).toBe("https://github.com/scottnaddle/dawer-releases/releases/tag/v1.0.3");
    expect(u?.dmgUrl).not.toContain(RELEASES_REPO);
  });
});
