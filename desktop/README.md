# UBION Messenger (desktop)

Windows + macOS desktop client for the on-prem DaouOffice messenger (`https://coco.ubion.co.kr`).
appId `global.ubion.messenger` · artifacts `UBION-Messenger-<version>-…`

## Architecture

```
electron/core/            ← messenger-core (no Electron imports; reusable by a phase-2 bot adapter)
  daou-client.ts          REST client (GOSSOcookie SSO, transparent re-login on 401, uploads/downloads, org)
  xmpp.ts                 plain-TCP XMPP (Openfire :5222, SASL PLAIN, ping, backoff reconnect, presence)
  messenger.ts            MessengerCore: events (ready/rooms/message/confirm/presence/connection/loggedOut)
                          + commands (login, history, sendText, sendFile, markRead, users, openDirect, …)
  messages.ts             messageId normalisation + optimistic/echo dedupe
electron/main.ts          window, tray, notifications, dock/taskbar badge, login item, IPC, ubion-media:// protocol
electron/settings.ts      settings JSON + password via safeStorage (Keychain / DPAPI)
electron/preload.ts       contextBridge `window.ubion`
src/                      React renderer (IPC only, no network access of its own)
```

Phase 2 (bot): instantiate `MessengerCore`, subscribe `core.on("message", …)`, reply with `core.sendText(roomKey, text)`;
expose that over a local HTTP/WebSocket API for the Hermes Agent adapter.

## Dev

```bash
cd desktop
npm install
npm run dev          # electron-vite dev (hot reload)
npm test             # vitest (protocol framing, routing, IME, dedupe)
npm run typecheck
npm run shot         # headless mock-data screenshot → ../shot-desktop.png
```

Live read-only smoke test of the core (office network only):

```bash
npm run smoke:bundle
UBION_USER=<id> UBION_PW="$(security find-generic-password -a <id> -s daou-coco -w)" node dist-smoke/live-smoke.cjs
```

## Build

- Windows: `npm run dist:win` (on Linux needs wine) → `release/UBION-Messenger-<v>-Setup.exe`
- macOS: `npm run dist:mac` (on a Mac / GitHub Actions `macos-14`) → `release/UBION-Messenger-<v>-{arm64,x64}.dmg` (unsigned:
  first launch via right-click → Open, or `xattr -dr com.apple.quarantine "/Applications/UBION Messenger.app"`)
- CI: `.github/workflows/build.yml` builds both on push/tag and uploads artifacts.

## Flavors (UBION Messenger / 다워)

One codebase, two products. `UBM_FLAVOR` is read when electron-vite starts and baked into the bundle. Default is **ubion**, so `npm run dev` / `npm run dist` stay UBION Messenger.

| | ubion (default) | generic (다워 / Dawer) |
|---|---|---|
| Flag | unset, `ubion` | `generic` or `dawer` |
| UI name | UBION Messenger | 다워 (Korean) · Dawer (other languages, installer) |
| appId | `global.ubion.messenger` | `global.ubion.dawer` |
| Dev appId | `global.ubion.messenger.dev` (unpackaged, or `UBM_APP_CHANNEL=dev`) | `global.ubion.dawer.dev` |
| Server | `https://coco.ubion.co.kr` | blank — type the tenant URL on the login screen |
| flex.team / `@ubion.co.kr` | on | off |
| Reactions, polls, status server, 유비온봇 | on when the flavor is ubion (same env flags as before) | off. `hasCoreLicense()` is always false, so Free does not call a bot |
| Updates | `ubion-messenger-releases` | none |
| Settings folder | `UBION Messenger` | `Dawer` (does not share the company profile) |
| App icon | blue UB monogram, `resources/icon.*` | warm 다 mark, `resources/dawer/` |

```bash
cd desktop
npm run dev                 # UBION Messenger
npm run dev:dawer           # 다워  (UBM_FLAVOR=generic)
npm run dist                # ubion installers
npm run dist:dawer          # Dawer installers, not published
```

다워 shows a one-line notice: **비공식 클라이언트**. It is not the official DaouOffice app and does not use DaouOffice branding.

### Dawer icon

Dawer builds use `resources/dawer/` for the installer (icns, ico, Linux png), the window icon, the macOS dock icon, and the tray. UBION Messenger keeps `resources/icon.*` and the blue monogram. The two sets are different files, so a side-by-side install does not share a tray or shortcut image.

The mark is the syllable **다** in cream `#FFF7F2` on a rounded square. The background runs from coral `#FF8F6B` (top-left) to warm red `#E24B4B` (bottom-right), the same colors as the in-app 다워 logo. It is not the UBION “U”, and it is not a DaouOffice or LG U+ asset. The menu-bar template is the syllable alone, in black, so macOS can tint it.

Regenerate the rasters (Pillow, plus a Hangul font such as `fonts-wqy-microhei`):

```bash
python3 desktop/scripts/render-dawer-icons.py
```

## Multi-tenant bot (skeleton only)

There is **no bot server in this repository**. The desktop client calls an external service. UBION uses `https://bot.ubion.global` (override `UBM_BOT_API_URL`). That deployment is one Ubion tenant and does not receive `X-UBM-Tenant`. Dawer Free does not call it: `UBM_BOT_API_URL` is ignored unless a future license says otherwise.

The runtime gate is `coreFeaturesEnabled` in `electron/core/subscription.ts`:

```ts
flavor === "ubion" || hasCoreLicense(serverUrl, key)
```

`hasCoreLicense` always returns false. A parsed subscription key is not a purchase. Payments are not implemented. Turning Core on for 다워 means replacing that function with a real verifier, then pointing the client at a multi-tenant bot URL. Do not reuse `bot.ubion.global` as the Dawer default.

**Where the server work lands.** Add it to the external bot service (or a new service), not to Electron. Port the key helpers in `electron/core/tenant.ts` and use them as the primary key before any `roomSeq` lookup:

| Record | Key | Example |
|---|---|---|
| Reactions, polls | `host+roomSeq` | `tenant.example+27673` |
| Status text (its own table) | `host+userSeq` | `tenant.example+42` |
| Bot room settings | `host+room:<seq>` | `tenant.example+room:27673` |

`host` is the Daou server host from the login URL (`https://tenant.example:8443/x` → `tenant.example:8443`). Two companies that both have room 27673 stay apart. Status uses the same `host+number` shape in a different table so user 42 is not room 42.

**Auth boundary.** DaouOffice cookies never leave the tenant. The bot keeps the existing ubt1 DM challenge (`X-UBM-User-Seq` + `X-UBM-Session`). A future multi-tenant request may add `X-UBM-Tenant: <host>`. The client sends that header only when the flavor is not ubion and Core is on. No live Daou bot account is required for this skeleton.

Subscription key shape (stub, not verified): `{ v: 1, tenantHost, tier: "core", keyId }`. `keyId` is opaque. It must match `tenantHost(serverUrl)` before a future verifier would even look at it, and this build still returns false after a match.

## 자동 업데이트 / 릴리스 (v1.0.3+)

- 배포 저장소(공개, 설치 파일만): https://github.com/scottnaddle/ubion-messenger-releases
- Windows: electron-updater 로 시작 시·4시간마다 확인 → 백그라운드 다운로드 → '새 버전 설치 후 다시 시작' 또는 종료 시 설치.
- macOS(미서명): latest-mac.yml 로 새 버전 감지 → 맞는 아키텍처 dmg 를 ~/Downloads 로 받아 열기 → 응용 프로그램으로 끌어 '대치'.
- 설정: 현재 버전, '업데이트 확인', 자동 확인 토글.
- 릴리스: 버전 올리기 → commit/push → Mac 에서 `desktop/scripts/release.sh` (CI 대기·산출물 다운로드·gh release create). 토큰 불필요(gh 로그인 사용).
- 검증: `node desktop/scripts/verify-update.mjs 1.0.2`
