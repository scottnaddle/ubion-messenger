/** Read-only: compare core room kinds/unread/filters vs raw REST. Prints counts only. */
import { MessengerCore } from "../electron/core/messenger";
import { roomMatchesFilter } from "../electron/core/messages";

async function main() {
  const core = new MessengerCore();
  const me = await core.login({ serverUrl: "https://coco.ubion.co.kr", username: process.env.UBION_USER!, password: process.env.UBION_PW! });
  const raw: any[] = [];
  for (let p = 0; p < 10; p++) {
    const b = JSON.parse((await core.client.request(`/api/chat/new/buddies?offset=40&page=${p}&userSeq=${me.id}`)).text);
    raw.push(...b.data);
    if (!b.hasNext || !b.data.length) break;
  }
  const rooms = await core.refreshRooms();
  const expectKind = (x: any) => (x.buddySeq != null ? "buddy" : x.roomType === "pubsub" ? "pubsub" : "room");
  const byKey = new Map(rooms.map((r) => [r.key, r]));
  let kindMis = 0, unreadMis = 0, missing = 0, selfMis = 0;
  for (const x of raw) {
    const k = `${expectKind(x)}:${x.buddySeq ?? x.roomSeq ?? x.pubsubSeq}`;
    const r = byKey.get(k);
    if (!r) { missing++; continue; }
    if (r.kind !== expectKind(x)) kindMis++;
    if (r.unread !== (x.unreadMessageCount || 0)) unreadMis++;
    if (r.isSelf !== (x.buddyRoomType === "my")) selfMis++;
  }
  const restUnread = raw.reduce((n, x) => n + (x.unreadMessageCount || 0), 0);
  const oldBadge = rooms.reduce((n, r) => n + (r.usePush ? r.unread : 0), 0);
  const oldGroupTab = rooms.filter((r) => r.kind !== "buddy").length;
  const restGroups = raw.filter((x) => x.roomType === "group").length;
  console.log({ rest: raw.length, core: rooms.length, missing, kindMis, unreadMis, selfMis,
    restUnreadTotal: restUnread, newBadge: core.unreadTotal(), oldBadge,
    groupTab: { rest: restGroups, before: oldGroupTab, after: rooms.filter((r) => roomMatchesFilter(r, "group")).length },
    dmTab: { rest: raw.filter((x) => x.buddySeq != null).length, after: rooms.filter((r) => roomMatchesFilter(r, "dm")).length },
    unreadTab: { rest: raw.filter((x) => x.unreadMessageCount > 0).length, after: rooms.filter((r) => roomMatchesFilter(r, "unread")).length },
    mutedRooms: rooms.filter((r) => !r.usePush).length });
  // receipts sanity on REST: in 1:1, my messages carry needConfirmCount 0/1
  const b = rooms.find((r) => r.kind === "buddy" && !r.isSelf)!;
  const h = await core.history(b.key);
  const mine = h.filter((m) => m.sendUserSeq === me.id);
  console.log("1:1 mine need", [...new Set(mine.map((m) => m.needConfirmCount))], "confirmUsers parsed", h.every((m) => Array.isArray(m.confirmUsers)));
  const g = rooms.find((r) => r.kind === "room")!;
  const mem = await core.members(g.key);
  const gh = await core.history(g.key);
  const last = gh[gh.length - 1];
  console.log("group members", mem.length, "memberCount", g.memberCount, "last need", last?.needConfirmCount, "readers", last?.confirmUsers?.length,
    "unread-from-members", mem.filter((u) => u.userId !== last.sendUserSeq && !last.confirmUsers!.includes(u.userId)).length);
  core.shutdown();
  process.exit(0);
}
main().catch((e) => (console.error("FAILED", e?.message), process.exit(1)));
