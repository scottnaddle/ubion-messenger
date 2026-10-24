/**
 * electron-builder config for both flavors.
 * package.json has no "build" key so electron-builder loads electron-builder.cjs,
 * which calls buildConfig(process.env). Default (no UBM_FLAVOR) is the ubion config.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const base = JSON.parse(fs.readFileSync(path.join(root, "electron-builder.base.json"), "utf8"));
const profiles = JSON.parse(fs.readFileSync(path.join(root, "electron", "flavor-profiles.json"), "utf8"));

function resolveFlavor(env = process.env) {
  const v = String(env.UBM_FLAVOR || "").trim().toLowerCase();
  if (v === "generic" || v === "dawer") return "generic";
  return "ubion";
}

function buildConfig(env = process.env) {
  const cfg = JSON.parse(JSON.stringify(base));
  const id = resolveFlavor(env);
  const p = profiles[id];
  const dev = String(env.UBM_APP_CHANNEL || "").trim() === "dev";
  if (id === "ubion") {
    if (dev) cfg.appId = p.appIdDev;
    return cfg;
  }
  const prefix = p.artifactPrefix;
  cfg.appId = dev ? p.appIdDev : p.appId;
  cfg.productName = p.productName;
  cfg.artifactName = `${prefix}-\${version}-\${os}-\${arch}.\${ext}`;
  cfg.mac = { ...cfg.mac, artifactName: `${prefix}-\${version}-\${arch}-mac.\${ext}` };
  cfg.nsis = {
    ...cfg.nsis,
    artifactName: `${prefix}-\${version}-Setup.\${ext}`,
    shortcutName: p.productName,
  };
  cfg.dmg = { ...cfg.dmg, artifactName: `${prefix}-\${version}-\${arch}.\${ext}` };
  const iconDir = p.iconDir ? `resources/${p.iconDir}` : "resources";
  cfg.mac = { ...cfg.mac, icon: `${iconDir}/icon.icns` };
  cfg.win = { ...cfg.win, icon: `${iconDir}/icon.ico` };
  cfg.linux = { ...cfg.linux, icon: `${iconDir}/icon-1024.png` };
  cfg.extraResources = [
    {
      from: iconDir,
      to: iconDir,
      filter: ["*.png", "*.ico", "*.icns"],
    },
  ];
  delete cfg.publish;
  cfg.extraMetadata = {
    description: "다워 (Dawer) — 비공식 클라이언트",
    author: "Dawer",
  };
  return cfg;
}

module.exports = { buildConfig, resolveFlavor };
