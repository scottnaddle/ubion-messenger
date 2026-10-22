/**
 * Live realtime check (office network). Opens the user's OWN self-chat room and, if SELF_SEND=1,
 * posts one test message there via a SEPARATE client (simulating the official app). Never messages others.
 * Prints ids/counts only.
 */
import { MessengerCore } from "../electron/core/messenger";
import { DaouClient } from "../electron/core/daou-client";

async function main() {
  const creds = { serverUrl: "https://coco.ubion.co.kr", username: process.env.UBION_USER!, password: process.env.UBION_PW! };
  const core = new MessengerCore();
  const got: string[] = [];
  core.on("message", (m) => got.push(`${m.roomKey === `buddy:${core.user!.id}` ? "self" : "other"}:${m.messageId}:${m.isMine ? "mine" : "theirs"}@${Date.now() - t0}ms`));
  const me = await core.login(creds);
  await core.refreshRooms();
  const key = `buddy:${me.id}`;
  core.setActiveRoom(key);
  core.noteSeen(key, await core.history(key));
  await new Promise((r) => setTimeout(r, 4000));
  var t0 = Date.now();
  if (process.env.SELF_SEND === "1") {
    const other = new DaouClient();
    await other.login(creds);
    const r = await other.sendMessage("buddy", me.id, "[UBION Messenger 동기화 테스트 – 무시하세요]");
    console.log("sent from 2nd client mid", r.messageId);
  }
  await new Promise((r) => setTimeout(r, Number(process.env.LISTEN_S || 30) * 1000));
  console.log("events", got);
  core.shutdown();
  process.exit(0);
}
main().catch((e) => (console.error("FAILED", e?.message), process.exit(1)));
