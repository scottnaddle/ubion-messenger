import { randomBytes } from "crypto";
import { hashToken } from "./auth";
/** Prints a new token once (give to the client) and the record to append to BOT_TOKENS_FILE. */
const id = process.argv[2] || "hermes"; const t = `dbt_${randomBytes(32).toString("base64url")}`;
console.log(`token (show once): ${t}`);
console.log(JSON.stringify({ id, sha256: hashToken(t), scopes: ["events:read", "messages:send", "rooms:read"] }));
