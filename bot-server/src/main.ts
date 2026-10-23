import fs from "fs";
import { Allowlist, TokenStore, type TokenRecord } from "./auth";
import { Audit } from "./audit";
import { CorePort } from "./core-port";
import { NotConfiguredPort, daouConfigured } from "./not-configured-port";
import { BotServer } from "./server";

/** Secrets: DAOU_BOT_USER / DAOU_BOT_PASSWORD_FILE (or _PASSWORD), BOT_TOKENS_FILE (JSON TokenRecord[] with sha256 only), BOT_ROOMS (comma list). */
const env = (k: string, d?: string) => { const v = process.env[k] ?? d; if (v == null) throw new Error(`missing env ${k}`); return v; };
const password = () => {
  const file = process.env.DAOU_BOT_PASSWORD_FILE;
  if (file) { try { if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim(); } catch { /* fall back to env */ } }
  return process.env.DAOU_BOT_PASSWORD;
};
async function main() {
  const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
  const user = process.env.DAOU_BOT_USER;
  const pass = password();
  let port: CorePort | NotConfiguredPort;
  if (daouConfigured(user, pass)) {
    port = new CorePort({ serverUrl: env("DAOU_SERVER", "https://coco.ubion.co.kr"), username: user!, password: pass! }, log);
  } else {
    log("daou credentials not configured; running degraded");
    port = new NotConfiguredPort();
  }
  const tokens = new TokenStore(JSON.parse(fs.readFileSync(env("BOT_TOKENS_FILE"), "utf8")) as TokenRecord[]);
  const srv = new BotServer({ port, tokens, allowlist: new Allowlist(env("BOT_ROOMS").split(",").map((s) => s.trim()).filter(Boolean)), mentionOnly: env("BOT_MENTION_ONLY", "0") === "1", audit: new Audit((l) => log(`[audit] ${l}`)) });
  const p = await srv.listen(Number(env("BOT_PORT", "8787")), env("BOT_HOST", "127.0.0.1"));
  log(`bot api on :${p}`); await port.start();
}
main().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
