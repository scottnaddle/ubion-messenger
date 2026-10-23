# Daou Bot API — spec (Phase 2)

Status: draft, implemented locally in `bot-server/` (branch `feature/bot-api`). Not deployed.
Consumer: Hermes Agent `daouoffice` adapter on the lms server (212.47.67.143).

## 0. Reachability (checked 2026-10-23 ~10:00 KST)
| from | DNS coco.ubion.co.kr | GET / | GET /api/user/session (no auth) |
|---|---|---|---|
| lms 212.47.67.143 | 211.193.3.243 | 302 in 1.14 s | 401 in 0.89 s |
| box | 198.18.0.1 (sandbox proxy) | 302 in 2.00 s | 401 in 1.96 s |
Both reach the server; 401 is the expected unauthenticated answer. BOSH (XMPP over HTTPS, 443) is therefore usable from lms; plaintext 5222 was not tested and stays disabled.

## 1. Bot service
- Headless Node 20 process (`bot-server/src/main.ts`) that reuses `desktop/electron/core` (`MessengerCore` = REST + BOSH, `DaouClient`) unchanged, via the `DaouPort` interface (`src/types.ts`, real impl `src/core-port.ts`).
- Logs in as **one dedicated DaouOffice bot account** (e.g. `ubm-bot`). Never a personal account; never the web-login/OTP path (an OTP-gated account is not supported → bot halts).
- Secrets from env / files on the server only: `DAOU_BOT_USER`, `DAOU_BOT_PASSWORD_FILE` (mode 0600, root/service user), `BOT_TOKENS_FILE`. The username is masked in logs (`u***t`); password, cookies (GOSSOcookie) and tokens are never logged.
- Session: MessengerCore already re-logs in on 401 using stored credentials. On top of that `ReloginPolicy`:
  - transient (network/5xx) failure → exponential backoff 5 s ×2 up to 15 min, ±20 % jitter;
  - credential rejection (401/403/web-login required) → at most **2** attempts total, then `halted` (health shows `daou:"halted"`), no further logins until an operator fixes the secret and restarts. This keeps us far under DaouOffice's lockout threshold (typically 5).
- One process, one account, one session. Run under systemd with `Restart=on-failure`, `RestartSec=60` (restart counts as a fresh attempt budget, so keep RestartSec ≥ 60 s and `StartLimitBurst=3`).
- Bind `127.0.0.1:8787` by default; expose through the existing reverse proxy with TLS only if Hermes is not on the same host (it is — so loopback is enough).

## 2. Auth
- Clients use `Authorization: Bearer <token>`. Tokens are `dbt_` + 32 random bytes (base64url), issued with `npx tsx src/issue-token.ts <id>`; shown once.
- At rest only `sha256` is stored in `BOT_TOKENS_FILE`: `[{ "id":"hermes", "sha256":"…", "scopes":[…], "rooms":[optional subset] }]`. Compare is constant-time.
- Scopes: `events:read` (WS), `messages:send` (POST /bot/send), `rooms:read` (GET /bot/rooms).
- **Room allowlist** `BOT_ROOMS` (comma list of room keys, e.g. `room:123,buddy:456`). Only these rooms are ever delivered on the WS, listed, or sendable. A token may further narrow with `rooms`.
- **Mention-only mode** `BOT_MENTION_ONLY=1`: only messages that mention the bot (`@<bot name>` or bot user id in `mentions`) are delivered.
- The bot's own messages are never delivered (loop prevention).

## 3. Endpoints
### GET /bot/health (no auth)
`200 {"ok":true,"daou":"online|connecting|reconnecting|offline|halted","ws_clients":1,"last_event_id":"42"}` — no PII.

### WS /bot/ws[?after=<event_id>]  (scope events:read)
Server → client JSON frames:
- `{"type":"hello","last_event_id":"42"}` on connect.
- `message.created`: `{type, event_id, room_id, room_name, sender:{id,name}, text, mentions[], attachments[{name,size?,type?}], reply_to, ts}`.
- `room.joined`: `{type, event_id, room_id, room_name, ts}` (bot was added to an allowlisted room).
- `heartbeat`: `{type:"heartbeat", ts, last_event_id}` every 25 s; client should reconnect if none for 60 s.
- `resume.gap`: `?after` is older than the buffer (5000 events, in memory) → client treats state as reset.
`event_id` is a monotonically increasing decimal string per process. Resume: reconnect with `?after=<last processed event_id>`; events after it (allowlisted for that token) are replayed before live ones. A process restart resets the sequence (hello's `last_event_id` < client's cursor ⇒ treat as reset). Delivery is at-least-once; clients dedupe on `event_id`.

### POST /bot/send  (scope messages:send)
Body `{room_id, text, reply_to?, client_msg_id}`; text 1–4000 chars; body ≤ 64 KB.
- `200 {"ok":true,"message_id":123,"client_msg_id":"…"}`; a repeat with the same `(token, client_msg_id)` within 24 h returns the same result with `"duplicate":true` and does not resend (concurrent duplicates share one in-flight send).
- Upstream failure (`502 upstream_error`) is **not** cached → safe to retry with the same id.
- `reply_to`: DaouOffice chat has no native reply thread in the REST send; accepted and audited, text is sent as-is (adapter may quote).

### GET /bot/rooms  (scope rooms:read)
`200 {"rooms":[{"room_id":"room:1","room_name":"…"}]}` — allowlisted (∩ token rooms) only.

## 4. Rate limits
Token bucket: per token 10 burst / 1 msg/s; per room 5 burst / 1 msg per 2 s. Over limit → `429 rate_limited`, `Retry-After` seconds, body `retry_after_s`. (Protects the bot account from looking like spam to DaouOffice.)

## 5. Audit log (metadata only)
JSON lines to stdout/journald: `{ts, action:"send"|"ws.connect", token_id, room_id, client_msg_id, status:"ok"|"denied"|"limited"|"error", code}`. Never message text, tokens, cookies, or credentials.

## 6. Errors
`{"error":{"code","message"}}`
| HTTP | code | meaning |
|---|---|---|
| 400 | bad_request / bad_text | invalid JSON/fields; empty or too long text |
| 401 | unauthorized | missing/invalid token (WS: upgrade refused with 401) |
| 403 | forbidden_scope / room_not_allowed | scope missing; room not allowlisted |
| 404 | not_found | unknown endpoint |
| 429 | rate_limited | see Retry-After |
| 502 | upstream_error | DaouOffice failed; retry same client_msg_id |
| 500 | internal | bug |

## 7. Example Hermes adapter flow
1. On start `GET /bot/health`; if `daou != online` keep polling (back off).
2. `GET /bot/rooms` → map room_id → channel.
3. Open `WS /bot/ws?after=<persisted cursor>`; on `message.created` hand `{room_id, sender, text}` to the agent, then persist `event_id` as cursor. On `resume.gap` or hello with lower last_event_id → reset cursor.
4. Agent reply → `POST /bot/send {room_id, text, client_msg_id: "hermes-<event_id>-<n>"}` (deterministic id ⇒ retries are safe). On 429 sleep `Retry-After`; on 502 retry with backoff ≤ 3 times.
5. Reconnect WS on close / 60 s without heartbeat, with backoff 1 s→30 s.

## 8. Config (env)
`DAOU_SERVER` (default https://coco.ubion.co.kr), `DAOU_BOT_USER`, `DAOU_BOT_PASSWORD_FILE`, `BOT_TOKENS_FILE`, `BOT_ROOMS`, `BOT_MENTION_ONLY`, `BOT_HOST` (127.0.0.1), `BOT_PORT` (8787).

## 9. Open items needing approval
Dedicated bot account; deploy on lms (systemd unit, user, secret files); bind/port/domain; token issuance for Hermes; room allowlist contents. Known limits: event buffer is in-memory; idempotency cache in-memory (lost on restart).
