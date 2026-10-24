/** Release feed of a public installers-only repo. No token needed. Pure + Node-testable. */
export type UpdateFeed = {
  owner: string;
  repo: string;
  /** dmg file prefix. UBION is `UBION-Messenger`; a future Dawer feed is `Dawer`. */
  artifactPrefix: string;
};

export const RELEASES_OWNER = "scottnaddle";
export const RELEASES_REPO = "ubion-messenger-releases";
export const UBION_UPDATE_FEED: UpdateFeed = {
  owner: RELEASES_OWNER,
  repo: RELEASES_REPO,
  artifactPrefix: "UBION-Messenger",
};
export const RELEASES_PAGE = `https://github.com/${RELEASES_OWNER}/${RELEASES_REPO}/releases`;

/**
 * Feed for this flavor. Null when updates are off or the repo is blank.
 * Dawer is null today. Plug in `dawer-releases` later; do not point it at ubion-messenger-releases.
 */
export function resolveUpdateFeed(input: {
  updates: boolean;
  updateOwner: string;
  updateRepo: string;
  artifactPrefix: string;
}): UpdateFeed | null {
  const owner = input.updateOwner.trim();
  const repo = input.updateRepo.trim();
  if (!input.updates || !owner || !repo) return null;
  return { owner, repo, artifactPrefix: input.artifactPrefix };
}

export function releasesPage(feed: UpdateFeed): string {
  return `https://github.com/${feed.owner}/${feed.repo}/releases`;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Minimal parser for electron-builder latest*.yml (version, files[].url, releaseDate). */
export function parseLatestYml(text: string): { version: string; files: string[]; releaseDate?: string } {
  const version = /^version:\s*['"]?([^'"\s]+)/m.exec(text)?.[1] || "";
  const files = [...text.matchAll(/^\s*-\s*url:\s*['"]?([^'"\s]+)/gm)].map((m) => m[1]);
  const releaseDate = /^releaseDate:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(text)?.[1];
  return { version, files, releaseDate };
}

export type UpdateInfo = { version: string; dmgUrl?: string; pageUrl: string; releaseDate?: string };

/**
 * Checks latest-mac.yml of the latest public release; returns info only if newer than current.
 * The default feed is the UBION installer repo. Pass null to skip the network (Dawer today).
 */
export async function checkMacUpdate(
  current: string,
  arch: string,
  fetchImpl: typeof fetch = fetch,
  feed: UpdateFeed | null = UBION_UPDATE_FEED,
): Promise<UpdateInfo | null> {
  if (!feed?.owner || !feed.repo) return null;
  const base = `https://github.com/${feed.owner}/${feed.repo}/releases/latest/download`;
  const res = await fetchImpl(`${base}/latest-mac.yml`, { redirect: "follow", headers: { "User-Agent": "UBIONMessenger-Updater" } });
  if (res.status === 404) return null; // no release yet
  if (!res.ok) throw new Error(`업데이트 정보 HTTP ${res.status}`);
  const info = parseLatestYml(await res.text());
  if (!info.version || compareVersions(info.version, current) <= 0) return null;
  const a = arch === "arm64" ? "arm64" : "x64";
  const dmgName = `${feed.artifactPrefix}-${info.version}-${a}.dmg`;
  return {
    version: info.version,
    releaseDate: info.releaseDate,
    dmgUrl: `https://github.com/${feed.owner}/${feed.repo}/releases/download/v${info.version}/${dmgName}`,
    pageUrl: `${releasesPage(feed)}/tag/v${info.version}`,
  };
}
