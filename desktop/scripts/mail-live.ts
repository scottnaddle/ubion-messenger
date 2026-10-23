/**
 * Read-only live check of native mail (v1.0.11). Run on the office-network Mac:
 *   UBION_USER=cwdaddy UBION_PW="$(security find-generic-password -a cwdaddy -s daou-coco -w)" node mail-live.cjs
 * Prints counts/shapes only — never subjects, names, addresses or bodies.
 * Reads (which mark read) ONLY a message that is already seen=true. Never sends/deletes/moves.
 */
import { DaouClient } from "../electron/core/daou-client";
import { PortalService } from "../electron/core/portal";

async function main() {
  const pw = process.env.UBION_PW, user = process.env.UBION_USER;
  if (!pw || !user) throw new Error("UBION_USER/UBION_PW required");
  const client = new DaouClient();
  await client.login({ serverUrl: "https://coco.ubion.co.kr", username: user, password: pw });
  const posts: string[] = [];
  const svc = new PortalService(async (p, init) => {
    if (init?.method === "POST") posts.push(p);
    return client.request(p, init?.method === "POST" ? { method: "POST", json: init.json } : { method: "GET" });
  }, () => undefined);
  const t = async <T>(name: string, fn: () => Promise<T>, shape: (v: T) => unknown) => {
    const s = Date.now();
    try { const v = await fn(); console.log("OK  ", name, JSON.stringify(shape(v)), `${Date.now() - s}ms`); return v; }
    catch (e) { console.log("FAIL", name, (e as Error).message); return null; }
  };
  const f = await t("folders", () => svc.mailFolders(), (x) => ({ def: x.defaultFolders.map((d) => `${d.fullName}:${d.unseenCnt}/${d.totalCnt}`), user: x.userFolders.length, shared: x.userSharedFolders.length }));
  const p1 = await t("list Inbox p1", () => svc.mailList("Inbox", 1), (x) => ({ n: x.items.length, total: x.total, unread: x.unread, page: x.page, pageSize: x.pageSize, last: x.lastPage, attach: x.items.filter((m) => m.hasAttach).length, unseen: x.items.filter((m) => !m.seen).length, important: x.items.filter((m) => m.important).length, allHaveFrom: x.items.every((m) => !!m.from.address), allHaveDate: x.items.every((m) => !!m.dateUtc) }));
  const p2 = await t("list Inbox p2", () => svc.mailList("Inbox", 2), (x) => ({ n: x.items.length, page: x.page }));
  if (p1 && p2) console.log("     pages disjoint:", p1.items.every((a) => !p2.items.some((b) => b.uid === a.uid)), "p2 older:", Math.min(...p1.items.map((m) => m.uid)) > Math.max(...p2.items.map((m) => m.uid)));
  await t("search Inbox 'the'", () => svc.mailList("Inbox", 1, "the"), (x) => ({ n: x.items.length, total: x.total, search: x.search }));
  await t("search Inbox no-hit", () => svc.mailList("Inbox", 1, "zzqqxx-nohit"), (x) => ({ n: x.items.length, total: x.total, last: x.lastPage }));
  for (const d of f?.defaultFolders.filter((d) => d.fullName !== "Inbox").slice(0, 4) ?? []) await t(`list ${d.fullName}`, () => svc.mailList(d.fullName, 1), (x) => ({ n: x.items.length, total: x.total }));
  // read only an already-read message (with an attachment if possible)
  let target = null as null | { uid: number; folder: string; hasAttach: boolean };
  let anySeen = null as typeof target;
  for (let pg = 1; pg <= 40 && !target; pg++) {
    const l = await svc.mailList("Inbox", pg);
    const seen = l.items.filter((m) => m.seen);
    anySeen = anySeen ?? seen[0] ?? null;
    target = seen.find((m) => m.hasAttach) ?? null;
  }
  target = target ?? anySeen;
  if (!target) { console.log("no already-read message found; skipping read"); return; }
  if (!target) return;
  const m = await t("read (already seen)", () => svc.mailRead(target!.folder, target!.uid), (x) => ({ uidMatch: x.uid === target!.uid, hasSubject: !!x.subject, hasFrom: !!x.from.address, to: x.to.length, cc: x.cc.length, htmlLen: x.html.length, attach: x.attachments.length, attachFields: x.attachments[0] ? Object.keys(x.attachments[0]).join(",") : "-" }));
  if (m) {
    const s = sanitizeMailHtmlNode(m.html);
    console.log("     sanitized(node fallback):", s);
  }
  const after = await svc.mailList("Inbox", 1);
  console.log("     inbox unread unchanged:", p1?.unread === after.unread, "posts:", [...new Set(posts)]);
}
// DOMParser isn't available in plain node — report HTML traits instead of running the browser sanitizer.
function sanitizeMailHtmlNode(html: string) {
  return { scripts: (html.match(/<script/gi) || []).length, remoteImgs: (html.match(/<img[^>]+src=["']https?:/gi) || []).length, links: (html.match(/<a\s/gi) || []).length };
}
main().catch((e) => { console.error("ERROR", e?.message); process.exit(1); });
