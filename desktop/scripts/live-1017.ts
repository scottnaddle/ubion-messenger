/**
 * 1.0.17 safe live check (writes only to Scott's own data):
 *  - toggles push on the '나'(self) room off→on (restores original state)
 *  - adds then removes one favorite (FAV_ID env, default: self)
 * Never sends messages. Prints no names/cookies/passwords.
 *   UBION_USER=... UBION_PW=... npx tsx scripts/live-1017.ts
 */
import { MessengerCore } from "../electron/core/messenger";

async function main() {
  const user = process.env.UBION_USER, pw = process.env.UBION_PW;
  if (!user || !pw) throw new Error("UBION_USER/UBION_PW required");
  const core = new MessengerCore();
  const me = await core.login({ serverUrl: "https://coco.ubion.co.kr", username: user, password: pw });
  const rooms = await core.refreshRooms();
  const self = rooms.find((r) => r.isSelf);
  if (!self) throw new Error("self room not found");
  const orig = self.usePush;
  try {
    await core.client.setRoomPush(self.kind, self.seq, !orig);
    const after = (await core.refreshRooms()).find((r) => r.isSelf)!.usePush;
    console.log("room push", { orig, toggled: after === !orig });
  } finally {
    await core.client.setRoomPush(self.kind, self.seq, orig);
  }
  const restored = (await core.refreshRooms()).find((r) => r.isSelf)!.usePush;
  console.log("room push restored", { restored: restored === orig });

  const id = Number(process.env.FAV_ID || me.id);
  const before = await core.client.listFavorites();
  const alreadyFavorite = before.some((f) => f.userId === id);
  let added = false;
  try {
    if (alreadyFavorite) {
      console.log("favorites", { before: before.length, alreadyFavorite, skipped: true });
    } else {
      await core.client.addFavorite(id);
      added = true;
      const after = (await core.client.listFavorites()).length;
      console.log("favorites", { before: before.length, after, ok: after === before.length + 1 });
    }
  } finally {
    if (added) await core.client.removeFavorite(id);
  }
  const end = (await core.client.listFavorites()).length;
  console.log("favorites restored", { end, ok: end === before.length });
  process.exit(0);
}
main().catch((e) => { console.error("FAIL", String(e?.message || e).replace(/(JSESSIONID|GOSSO|token|password)=[^;\s]+/gi, "$1=***")); process.exit(1); });
