/**
 * Print the exact create-group request for member ids from argv.
 * Default: dry run, no network (set UBION_USER_SEQ to include your own id filtering).
 *   npx tsx scripts/live-group-create.ts 229 312
 * Actually create the room (logs in like live-smoke):
 *   UBM_GROUP_CREATE=1 UBION_USER=... UBION_PW=... npx tsx scripts/live-group-create.ts 229 312
 */
import { buildCreateGroupRoomPath } from "../electron/core/daou-client";
import { MessengerCore } from "../electron/core/messenger";

function printRequest(path: string) {
  console.log("method      POST");
  console.log("url        ", path);
  console.log("content-type application/json");
  console.log("body        {}");
}

async function main() {
  const memberIds = process.argv.slice(2).map(Number);
  const dryRun = process.env.UBM_GROUP_CREATE !== "1";
  if (dryRun) {
    const userSeq = Number(process.env.UBION_USER_SEQ || 0);
    printRequest(buildCreateGroupRoomPath(memberIds, userSeq));
    console.log("dry run: set UBM_GROUP_CREATE=1 to actually create the room");
    return;
  }
  const user = process.env.UBION_USER;
  const pw = process.env.UBION_PW;
  if (!user || !pw) throw new Error("UBION_USER/UBION_PW required");
  const core = new MessengerCore();
  const me = await core.login({ serverUrl: "https://coco.ubion.co.kr", username: user, password: pw });
  printRequest(buildCreateGroupRoomPath(memberIds, me.id));
  const roomSeq = await core.client.createGroupRoom(memberIds);
  console.log("created roomSeq", roomSeq);
  core.shutdown();
}

main().catch((e) => {
  console.error("FAILED", e instanceof Error ? e.message : "error");
  process.exit(1);
});
