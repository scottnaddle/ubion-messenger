# DaouOffice (Group Office) Messenger Protocol — coco.ubion.co.kr

Reverse-engineered 2026-10-22 (Asia/Seoul) against on-prem UBION Group Office +
**UBIONMessenger 3.5.42** (Electron desktop). Cloud `python-daouoffice-bot` portal
APIs (`/api/chat/room`, `/api/portal/*`) do **not** exist here.

> Secrets (password, `GOSSOcookie`, XMPP `subInfo` / derived key) are never written
> below. Proof script reads the macOS Keychain item `daou-coco` / account `cwdaddy`.

## Network constraints

- Server accepts Korean/office IPs only. Box egress is blocked; run clients from
  Scott’s Mac (`machineId daed135f-…`).
- Host: `https://coco.ubion.co.kr`
- XMPP domain (logical): `xmppdaou.com` (does **not** resolve in DNS)
- XMPP TCP host: `coco.ubion.co.kr:5222` (Openfire; **no STARTTLS**)
- BOSH: `POST https://coco.ubion.co.kr/http-bind/` (used by web notification layer)

## Auth (SSO cookie)

```
POST /api/login
Content-Type: application/json
{"username":"<loginId>","password":"<pw>","captcha":"","returnUrl":""}

→ 200 {"code":"200","data":{"redirect":"%2Fapp%2Fhome","xmppDomain":"xmppdaou.com","useSkipPwdChange":false}}
Set-Cookie: GOSSOcookie=…; rememberMe=…
```

- No captcha / 2FA observed for this account.
- Session: `GET /api/user/session` → user `id` / `repId` (same, e.g. 312),
  `loginId`, `companies[].userLoginId`, `useChat`, etc.
- Unauthenticated `/api/*` → 401 JSON; authenticated unknown path → 404 HTML.

Reuse the cookie jar. Avoid repeated logins (lock risk).

## Two client surfaces

| Surface | Transport | Purpose |
|--------|-----------|---------|
| Web app (`/app/home`) | REST + **BOSH** (`Strophe` via `go-notification.js`) | Portal + headline notifications |
| Desktop `UBIONMessenger` (Electron) | REST + **XMPP TCP 5222** (`node-xmpp-client`) | Full chat UI |

`siteconfig.messengerType = "Electron"`, `usePcMessenger = true`.
Installer: `GET /api/device/package/download` → `UBIONMessenger-3.5.42.dmg`.

## XMPP realtime

### Credentials

1. **Desktop path (preferred for proof):**
   - Bare localpart = `repId` (numeric string, e.g. `312`)
   - Domain = login `xmppDomain` (`xmppdaou.com`)
   - Resource = `go_pc_{repId}_{random}` (web uses `go_web_{repId}_{random}`)
   - Password = deterministic 10-char transform of `companies[].userLoginId`
     (see `xmpp_key()` in `proof_readonly.py`, mirrored from `main.prod.js` `Co`/`jo`)
2. **Web / BOSH path:**
   - `GET /api/bosh/user` → `{jid:"312@xmppdaou.com", subInfo:"<10-char>"}`
   - BOSH password = `subInfo` (also works as TCP SASL PLAIN password)

SASL: **PLAIN** (also offers CRAM-MD5). Auth username must be **bare localpart**
(`312`), not full JID. No TLS on 5222.

### Presence

Desktop sends `<presence><status>online:on</status></presence>` on connect,
`away:on` when idle, `type=unavailable` + `terminated PC messenger` on quit.
Server floods roster presence after bind (expected).

### Chat messages (push)

Incoming `<message>` body is **JSON** (not plain text), e.g. fields used by desktop:

- `type`: `message` | `confirm` | `presence` | …
- `subtype`: `single` | `pubsub` | `group` / `roomjoin` / `roomleave` / `roomkickout`
- `from`: `{userSeq,userName,userPosition,userImg,companyId,…}`
- `toSeq` / `from.userSeq`, `message`, `messageId`, `usePush`, `actiontype`, …

Web notification path listens for `message`/`headline` over BOSH for portal badges.

Ping: `urn:xmpp:ping` every ~60s from desktop.

## REST chat API (cookie auth)

All need `GOSSOcookie`. Typical query: `userSeq=<session.id>`.

### Room / conversation list

```
GET /api/chat/new/buddies?offset=40&page=0&userSeq={uid}
```

Returns mixed list (1:1 + group + broadcast-like). Fields include:

- 1:1: `buddySeq`, `buddyName`, `buddyRoomSeq`, `chatRoomName`, `message`, `messageId`, `unreadMessageCount`, `usePin`, `usePush`
- Group: `roomSeq`, `roomType=group`, `memberCount`, `memberName`, `sendUserName`, …
- Observed: **63** conversations across 2 pages for `cwdaddy` (page metadata `total` is unreliable / 0).

Related:

- `GET /api/chat/buddies/search?keyword=…&userSeq=`
- `POST /api/chat/rooms?memberSeq=…&userSeq=` → create/open room → `roomSeq`
- Pin: `PUT /api/chat/attachpin/{seq}?roomType=…&userSeq=`
- Mute: `PUT /api/chat/{buddies|rooms|pubsubs}/{seq}/push?userSeq=&usePush=`

### History (read-only safe)

```
GET /api/chat/buddies/{buddySeq}?size=N&userSeq={uid}
GET /api/chat/rooms/{roomSeq}?size=N&userSeq={uid}
GET /api/chat/{buddies|rooms}/{seq}?size=N&criteriaMessageId=…&userSeq=
GET /api/chat/{seq}/range?criteriaMessageId=&size=&arrow=up|down&userSeq=&roomType=single|room|pubsub
GET /api/chat/{seq}/search?offset=20&page=&keyword=&fromDate=&toDate=&userSeq=
```

Message object (REST): `messageId`, `sendUserName`, `sendUserSeq`, `targetUserSeq`,
`message`, `createdAt`, `confirmCount`, `needConfirmCount`, `confirmUsers`,
`userImage`, `companyId`, optional attach models.

**Mark-as-read (avoid in proof):**
`PUT /api/chat/{buddies|rooms}/{seq}/{messageId}/before?userSeq=`

**Send (do not use in phase-1 proof):**
`POST /api/chat/{buddies|rooms}/{seq}` `application/x-www-form-urlencoded`
(`message`, `resource`, `userSeq`, `tempMessageId`, …)

### Attachments

- List: `GET /api/chat/{buddies|rooms}/attaches/{seq}?size=&attachType=image|file&userSeq=`
- Download: `GET /api/chat/files/{cryptId}?userSeq=&messageId=`
- Upload path used by UI: `/api/chat/attach/{extension}?…` (not exercised)

### Org / directory

- `GET /api/users/accessible/entire?companyId={cid}` — flat user directory + presence `status`
- `GET /api/departments/tiny?companyId=` / `…/children?companyId=` — dept tree
- Profile: `GET /api/user/profile/{id}`, `GET /api/department/profile/{id}`

### Other

- Quick links: `GET /api/messenger/links?userSeq=`
- Noti center (portal): `GET /api/my/noti?…` (separate from chat XMPP)
- Config: `/api/userside/baseconfig`, `/api/siteconfig`, `/api/login/config`

## Proof results (2026-10-22 Asia/Seoul)

Script: `proof_readonly.py` (run on Mac with Keychain password).

| Check | Result |
|------|--------|
| Login + session | OK (`userSeq=312`) |
| List rooms | OK — **63** conversations |
| Fetch messages | OK — last 5 of buddy `229` |
| XMPP TCP connect / SASL / bind | OK — `session_start OK` |
| Chat messages in 60s listen | **0** (no traffic; presence flood observed in separate probe) |
| Mark-read / send | Not called |

## Architecture recommendation (replacement app)

1. **Desktop shell:** Tauri (preferred) or Electron — native notifications, tray,
   auto-start; matches current Electron messenger UX.
2. **Core client lib (Rust/TS or Python sidecar):**
   - REST session (`GOSSOcookie`) for rooms/history/files/org
   - Long-lived XMPP TCP client to `coco:5222` (PLAIN, no TLS) for realtime + presence
   - Keep Keychain / OS secret store for password; derive XMPP key client-side
3. **UI:** Slack-like sidebar (DMs / channels / unread), virtualized message list,
   org-directory picker. Reuse REST shapes above; don’t depend on BOSH unless you
   also need web-portal headline parity.
4. **Optional local bridge** (later): localhost HTTP/WebSocket for bots/integrations,
   translating to the same REST+XMPP stack (rate-limit logins; share one XMPP resource).
5. **Ops:** IP allowlist means clients must run on office/VPN network (or a small
   on-prem bridge host). Box/cloud agents cannot reach the server directly.


## Native mail list/read (v1.0.11, live-verified 2026-10-23)
- `POST /api/mail/message/list` JSON `{folder, page (1-based), offset (page size), keyWord?}` → `data{folderName, folderFullName, total, unreadMessageCount, pageInfo{page,pageSize,total,lastPage}, messageList[]}`.
  Items: `id, folderFullName, subject, from ("Name"<addr>), preview, dateUtc, seen, flag (S=seen, T=attachment, A=answered, F=flagged), priority, size`.
  `messageList` is omitted when empty. ⚠ Without `page`+`offset` the server returns the entire folder (11k+ items). Form-encoded body → 500.
- `POST /api/mail/message/read` JSON `{folder, uid}` → `data.msgContent{uid, subject, from, fromPersonal, dateUtc, htmlContent, priority, flaged, toList[{personal,address}], ccList?, attachList[{path,fileName,size,fileType,fsize}]}`. ⚠ Marks the message read.
- `GET /api/mail/folder/all` (POST → 405).
- Attachment download endpoint NOT found yet (`/api/mail/message/download|attach/download?folder&uid&part` → 500); app opens the message in web mail for downloads.
