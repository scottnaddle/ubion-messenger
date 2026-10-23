import fs from "fs";
import { Allowlist, TokenStore, type TokenRecord } from "./auth";
import { Audit } from "./audit";
import { CorePort } from "./core-port";
import { NotConfiguredPort, daouConfigured } from "./not-configured-port";
import { SqliteContextStore } from "./context";
import { BotServer, type ContextOpts } from "./server";

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
  const num = (k: string, d: number) => { const n = Number(env(k, String(d))); return Number.isFinite(n) ? n : d; };
  let context: ContextOpts | undefined;
  try {
    require("node:sqlite");
    context = {
      store: new SqliteContextStore(env("BOT_CONTEXT_DB", "/var/lib/ubm-bot/context.db")),
      retentionDays: num("BOT_CONTEXT_RETENTION_DAYS", 90),
      idleMinMessages: num("BOT_IDLE_MIN_MESSAGES", 5),
      idleMs: num("BOT_IDLE_MINUTES", 20) * 60_000,
    };
    log(`context enabled db=${env("BOT_CONTEXT_DB", "/var/lib/ubm-bot/context.db")}`);
  } catch (e) {
    log(`context disabled: ${String((e as any)?.message ?? e)}`);
  }
  const srv = new BotServer({ port, tokens, allowlist: new Allowlist(env("BOT_ROOMS").split(",").map((s) => s.trim()).filter(Boolean)), mentionOnly: env("BOT_MENTION_ONLY", "0") === "1", statusMode: env("BOT_STATUS_MODE", "chatstate") === "message" ? "message" : "chatstate", audit: new Audit((l) => log(`[audit] ${l}`)), trustedProxies: env("BOT_TRUSTED_PROXIES", "127.0.0.1,::1").split(",").map((x) => x.trim()).filter(Boolean), corsOrigins: (process.env.BOT_CORS_ORIGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean), ...(context ? { context } : {}) });
  const p = await srv.listen(Number(env("BOT_PORT", "8787")), env("BOT_HOST", "127.0.0.1"));
  log(`bot api on :${p}`); await port.start();
}
main().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
