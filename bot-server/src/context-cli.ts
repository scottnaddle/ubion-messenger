import { SqliteContextStore } from "./context";

const USAGE = "usage: tsx src/context-cli.ts purge <room_id> | prune [days] | stats";
const dbPath = process.env.BOT_CONTEXT_DB || "/var/lib/ubm-bot/context.db";
const [cmd, arg] = process.argv.slice(2);

function positiveInt(v: string | undefined, fallback: number): number | null {
  if (v == null || v === "") return fallback;
  if (!/^\d+$/.test(v)) return null;
  return Number(v);
}

function main(): number {
  if (cmd === "purge") {
    if (!arg) { console.error(USAGE); return 2; }
    const store = new SqliteContextStore(dbPath);
    try { console.log(`purged ${store.purgeRoom(arg)}`); return 0; }
    finally { store.close(); }
  }
  if (cmd === "prune") {
    const days = positiveInt(arg, Number(process.env.BOT_CONTEXT_RETENTION_DAYS ?? "90"));
    if (days == null) { console.error(USAGE); return 2; }
    const store = new SqliteContextStore(dbPath);
    try { console.log(`pruned ${store.prune(days * 24 * 3600_000)}`); return 0; }
    finally { store.close(); }
  }
  if (cmd === "stats") {
    const store = new SqliteContextStore(dbPath);
    try {
      const rooms = store.rooms();
      for (const r of rooms) console.log(`${r.room_id}\t${r.count}\t${r.last_ts}`);
      console.log(`total\t${rooms.reduce((n, r) => n + r.count, 0)}`);
      return 0;
    } finally { store.close(); }
  }
  console.error(USAGE);
  return 2;
}

try { process.exitCode = main(); }
catch (e) { console.error(String((e as any)?.message ?? e)); process.exitCode = 1; }
