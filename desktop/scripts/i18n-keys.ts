/**
 * 다국어 key scanner: collects the Korean source keys passed as string literals to t(...), tm(...) or tk(...).
 * Used by tests/i18n.test.ts; `npx tsx scripts/i18n-keys.ts [lang]` prints keys missing from that dictionary.
 */
import fs from "node:fs";
import path from "node:path";

const CALL = /(?<![\w$.])(?:t|tm|tk)\(\s*"((?:[^"\\\n]|\\.)*)"/g;
const ROOTS = ["src", "electron"];

function walk(dir: string, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "locales" && e.name !== "node_modules") walk(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

export function sourceFiles(root = process.cwd()): string[] {
  return ROOTS.flatMap((r) => walk(path.join(root, r), [])).filter((f) => !f.endsWith(path.join("src", "mock.ts")));
}

export function keysIn(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(CALL)) out.push(JSON.parse(`"${m[1]}"`) as string);
  return out;
}

/** key → files using it */
export function scanKeys(root = process.cwd()): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const f of sourceFiles(root)) {
    for (const k of keysIn(fs.readFileSync(f, "utf8"))) {
      const rel = path.relative(root, f);
      const list = map.get(k) || [];
      if (!list.includes(rel)) list.push(rel);
      map.set(k, list);
    }
  }
  return map;
}

if (process.argv[1] && /i18n-keys\.ts$/.test(process.argv[1])) {
  const lang = process.argv[2];
  const keys = [...scanKeys().keys()].sort();
  if (!lang) {
    console.log(JSON.stringify(keys, null, 1));
  } else {
    void import(`../src/lib/locales/${lang}.ts`).then((m: { default: Record<string, string> }) => {
      const dict = m.default;
      const missing = keys.filter((k) => !dict[k]);
      const extra = Object.keys(dict).filter((k) => !keys.includes(k));
      console.log(JSON.stringify({ total: keys.length, missing, extra }, null, 1));
    });
  }
}
