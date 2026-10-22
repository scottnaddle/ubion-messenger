import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

/** "test" when packaged with extraMetadata.ubionFlavor=test (side-by-side test build, no updater). */
export const FLAVOR: string = (() => {
  if (process.env.UBION_FLAVOR) return process.env.UBION_FLAVOR;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"));
    return pkg.ubionFlavor || "release";
  } catch {
    return "release";
  }
})();
export const IS_TEST_BUILD = FLAVOR === "test";
