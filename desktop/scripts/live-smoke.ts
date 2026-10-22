/**
 * Read-only live smoke test of messenger-core (no Electron). Run on the office-network Mac:
 *   UBION_USER=cwdaddy UBION_PW="$(security find-generic-password -a cwdaddy -s daou-coco -w)" node live-smoke.cjs
 * Prints counts/types only — never names, message text, cookies or passwords.
 * Does NOT send, mark read, pin, or create rooms.
 */
import { MessengerCore } from "../electron/core/messenger";

async function main() {
  const pw = process.env.UBION_PW;
  const user = process.env.UBION_USER;
  if (!pw || !user) throw new Error("UBION_USER/UBION_PW required");
  const core = new MessengerCore();
  const conn: string[] = [];
  core.on("connection", (c) => conn.push(c.state));
  let msgs = 0, pres = 0, confirms = 0;
  core.on("message", () => msgs++);
  core.on("presence", () => pres++);
  core.on("confirm", () => confirms++);
  const t0 = Date.now();
  const me = await core.login({ serverUrl: "https://coco.ubion.co.kr", username: user, password: pw });
  console.log("login ok", { hasId: !!me.id, ms: Date.now() - t0 });
  const rooms = await core.refreshRooms();
  const kinds: Record<string, number> = {};
  rooms.forEach((r) => (kinds[r.kind] = (kinds[r.kind] || 0) + 1));
  console.log("rooms", rooms.length, kinds, "unreadTotal", core.unreadTotal(), "sortedByTime", rooms.filter((r) => !r.usePin).every((r, i, a) => i === 0 || new Date(a[i - 1].createdAt!).getTime() >= new Date(r.createdAt!).getTime()));
  const buddy = rooms.find((r) => r.kind === "buddy" && !r.isSelf)!;
  const page1 = await core.history(buddy.key);
  const page2 = await core.history(buddy.key, page1[0]?.messageId);
  console.log("history", page1.length, "older", page2.length, "olderIsOlder", page2.length ? page2[page2.length - 1].messageId! < page1[0].messageId! : "n/a",
    "withTs", page1.every((m) => !!m.createdAt), "idsNumeric", page1.every((m) => typeof m.messageId === "number"));
  const group = rooms.find((r) => r.kind === "room");
  if (group) console.log("group history", (await core.history(group.key)).length);
  // find an image attachment across a few rooms
  let img: { path?: string; file?: string } | null = null;
  for (const r of rooms.slice(0, 15)) {
    const h = await core.history(r.key);
    const m = h.find((x) => x.attach?.imageFile);
    if (m?.attach) {
      img = { path: m.attach.thumbSmall, file: core.client.fileUrlPath(m.attach.cryptId, m.messageId) };
      break;
    }
  }
  if (img?.path) {
    const t = await core.client.fetchBinary(img.path);
    const f = await core.client.fetchBinary(img.file!);
    console.log("thumbnail", t.contentType.split(";")[0], t.data.length > 0, "| file download", f.contentType.split(";")[0], f.data.length > 0);
  } else console.log("no image attachment found in first rooms");
  const s = await core.searchInRoom(buddy.key, "a");
  console.log("in-room search results", s.length);
  const users = await core.users();
  const depts = await core.departments();
  console.log("users", users.length, "depts", depts.length, "usersWithDept", users.filter((u) => u.departmentIds.length).length);
  if (me.thumbnail) {
    try {
      const a = await core.client.fetchBinary(me.thumbnail);
      console.log("avatar", a.contentType.split(";")[0]);
    } catch (e) {
      console.log("avatar fetch failed", (e as Error).message);
    }
  }
  const listen = Number(process.env.LISTEN_S || 25);
  await new Promise((r) => setTimeout(r, listen * 1000));
  const online = Object.values(core.allPresence()).filter((p) => p !== "offline").length;
  console.log("xmpp states", conn.join(">"), "| presence events", pres, "online users", online, "| messages", msgs, "confirms", confirms);
  // reconnect test: force reconnect and wait for online again
  const before = conn.length;
  core.reconnect();
  await new Promise((r) => setTimeout(r, 6000));
  console.log("reconnect", conn.slice(before).join(">"));
  // cookie refresh test: drop cookies and make a REST call → should transparently re-login
  core.client.jar.removeAllCookiesSync();
  const again = await core.refreshRooms();
  console.log("cookie refresh relogin ok", again.length === rooms.length);
  core.shutdown();
  process.exit(0);
}
main().catch((e) => {
  console.error("FAILED", e instanceof Error ? e.message : "error");
  process.exit(1);
});
