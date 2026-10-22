/**
 * Read-only live check of PortalService (no Electron, no XMPP). Run on the office-network Mac:
 *   UBION_USER=cwdaddy UBION_PW="$(security find-generic-password -a cwdaddy -s daou-coco -w)" node portal-live.cjs
 * Prints shapes/counts only — never titles, names, bodies, cookies or passwords. GET-only (besides the existing login).
 */
import { DaouClient } from "../electron/core/daou-client";
import { PortalService } from "../electron/core/portal";

async function main() {
  const pw = process.env.UBION_PW, user = process.env.UBION_USER;
  if (!pw || !user) throw new Error("UBION_USER/UBION_PW required");
  const client = new DaouClient();
  await client.login({ serverUrl: "https://coco.ubion.co.kr", username: user, password: pw });
  const methods: string[] = [];
  const events: Record<string, number> = {};
  const svc = new PortalService(async (p, init) => { methods.push(init?.method || "?"); return client.request(p, { method: "GET" }); },
    (e) => (events[e] = (events[e] || 0) + 1));
  const run = async (name: string, fn: () => Promise<any>, shape: (v: any) => unknown) => {
    const t = Date.now();
    try { console.log("OK  ", name, JSON.stringify(shape(await fn())), `${Date.now() - t}ms`); }
    catch (e) { console.log("FAIL", name, (e as Error).message); }
  };
  const keys = (o: any) => (o ? Object.keys(o).filter((k) => o[k] !== undefined && o[k] !== "").sort().join(",") : "-");
  await run("summary /api/user/today", () => svc.fetchSummary(), (s) => ({ chips: s.chips.map((c: any) => `${c.appName}:${c.count}`) }));
  await run("posts /api/board/posts/company", () => svc.companyPosts(5), (l) => ({ n: l.items.length, total: l.total, fields: keys(l.items[0]), urlOk: l.items.every((p: any) => /^\/app\/board\/\d+\/post\/\d+/.test(p.url)), maxIdNum: Math.max(0, ...l.items.map((p: any) => p.id)) > 0 }));
  await run("approval todo", () => svc.approvals("todo", 5), (l) => ({ n: l.items.length, total: l.total, fields: keys(l.items[0]) }));
  await run("approval upcoming", () => svc.approvals("upcoming", 5), (l) => ({ n: l.items.length, total: l.total, fields: keys(l.items[0]) }));
  await run("approval todo/count", () => svc.approvalCount(), (n) => ({ count: n }));
  await run("noti /api/my/noti", () => svc.notis(10), (l) => ({ n: l.items.length, total: l.total, fields: keys(l.items[0]), cats: [...new Set(l.items.map((x: any) => x.category))] }));
  await run("noti unread count", () => svc.unreadNotiCount(), (n) => ({ unread: n }));
  await run("mail gadget", () => svc.mails(5), (l) => ({ n: l.items.length, total: l.total, fields: keys(l.items[0]), unseen: l.items.filter((m: any) => !m.seen).length }));
  await run("mail count", () => svc.mailCount(), (n) => ({ count: n }));
  await run("refreshAll", () => svc.refreshAll(), (ok) => ({ ok, badge: svc.snapshot().badge }));
  await run("whitelist blocks /api/login", () => svc.get("/api/login"), () => "UNEXPECTED");
  console.log("events", events, "methods", [...new Set(methods)]);
}
main().catch((e) => { console.error("ERROR", e?.message); process.exit(1); });
