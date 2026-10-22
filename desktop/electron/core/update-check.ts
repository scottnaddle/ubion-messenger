/** Release feed of the PUBLIC installers-only repo. No token needed. Pure + Node-testable. */
export const RELEASES_OWNER = "scottnaddle";
export const RELEASES_REPO = "ubion-messenger-releases";
export const RELEASES_PAGE = `https://github.com/${RELEASES_OWNER}/${RELEASES_REPO}/releases`;

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

/** Checks latest-mac.yml of the latest public release; returns info only if newer than current. */
export async function checkMacUpdate(current: string, arch: string, fetchImpl: typeof fetch = fetch): Promise<UpdateInfo | null> {
  const base = `https://github.com/${RELEASES_OWNER}/${RELEASES_REPO}/releases/latest/download`;
  const res = await fetchImpl(`${base}/latest-mac.yml`, { redirect: "follow", headers: { "User-Agent": "UBIONMessenger-Updater" } });
  if (res.status === 404) return null; // no release yet
  if (!res.ok) throw new Error(`업데이트 정보 HTTP ${res.status}`);
  const info = parseLatestYml(await res.text());
  if (!info.version || compareVersions(info.version, current) <= 0) return null;
  const a = arch === "arm64" ? "arm64" : "x64";
  const dmgName = `UBION-Messenger-${info.version}-${a}.dmg`;
  return {
    version: info.version,
    releaseDate: info.releaseDate,
    dmgUrl: `https://github.com/${RELEASES_OWNER}/${RELEASES_REPO}/releases/download/v${info.version}/${dmgName}`,
    pageUrl: `${RELEASES_PAGE}/tag/v${info.version}`,
  };
}
