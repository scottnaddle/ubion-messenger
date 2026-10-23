/**
 * 1.0.18 safe live check. Writes only to the user's own '나' room.
 *  - forwards one existing file attachment back into the self room
 *  - registers a message in the self room as the notice
 * Never takes a target from env and never calls forwardToMembers.
 * Prints no names/cookies/passwords/message text.
 *   UBION_USER=... UBION_PW=... npx tsx scripts/live-1018.ts
 */
import { MessengerCore } from "../electron/core/messenger";
import { apiRoomSeq } from "../electron/core/forward";
import type { ChatMessage } from "../electron/core/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function newestId(list: ChatMessage[]): number {
  return list.reduce((max, m) => Math.max(max, m.messageId || 0), 0);
}

async function findFileMessage(core: MessengerCore, key: string): Promise<ChatMessage | undefined> {
  let before: number | undefined;
  for (let page = 0; page < 5; page++) {
    const list = await core.history(key, before);
    const hit = list.find((m) => !!m.attach?.cryptId);
    if (hit) return hit;
    const ids = list.map((m) => m.messageId).filter((n): n is number => n != null);
    if (!ids.length) break;
    const oldest = Math.min(...ids);
    if (before != null && oldest >= before) break;
    before = oldest;
  }
  return undefined;
}

async function main() {
  const user = process.env.UBION_USER, pw = process.env.UBION_PW;
  if (!user || !pw) throw new Error("UBION_USER/UBION_PW required");
  const core = new MessengerCore();
  await core.login({ serverUrl: "https://coco.ubion.co.kr", username: user, password: pw });
  const rooms = await core.refreshRooms();
  const self = rooms.find((r) => r.isSelf);
  if (!self) throw new Error("self room not found");
  if (self.kind === "buddy" && !self.buddyRoomSeq) throw new Error("self room buddyRoomSeq missing");
  const selfSeq = apiRoomSeq(self);

  const initial = await core.history(self.key);
  const file = await findFileMessage(core, self.key);
  if (!file?.attach?.cryptId) {
    console.log("forward: skip (no file message in self room)");
  } else {
    const beforeMax = Math.max(self.messageId || 0, newestId(initial));
    await core.client.forwardToRoom(selfSeq, [file.attach.cryptId]);
    let appeared = false;
    let matching = false;
    for (let i = 0; i < 10 && !appeared; i++) {
      await sleep(1000);
      const page = await core.history(self.key);
      const fresh = page.filter((m) => (m.messageId || 0) > beforeMax);
      if (fresh.length) {
        appeared = true;
        matching = fresh.some((m) => m.attach?.cryptId === file.attach!.cryptId);
      }
    }
    console.log("forward", { ok: appeared, sameFile: matching, waitedMs: appeared ? "<=10000" : "10000" });
  }

  const latest = await core.history(self.key);
  const target = [...latest].sort((a, b) => (a.messageId || 0) - (b.messageId || 0)).at(-1);
  if (!target?.messageId) {
    console.log("notice: skip (no message in self room)");
  } else {
    const previous = self.notice?.messageId;
    await core.client.registerRoomNotice(selfSeq, target.messageId);
    const after = (await core.refreshRooms()).find((r) => r.isSelf);
    console.log("notice", { ok: after?.notice?.messageId === target.messageId, previousNoticeId: previous ?? null });
    if (previous) {
      let restored = false;
      try {
        await core.client.registerRoomNotice(selfSeq, previous);
        const restoredRoom = (await core.refreshRooms()).find((r) => r.isSelf);
        restored = restoredRoom?.notice?.messageId === previous;
      } catch {
        restored = false;
      }
      console.log("notice restore", { restored, previousNoticeId: previous });
    } else {
      console.log("notice restore: skip (no previous notice)");
    }
  }

  core.shutdown();
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL", String(e?.message || e).replace(/(JSESSIONID|GOSSO|token|password)=[^;\s]+/gi, "$1=***"));
  process.exit(1);
});
