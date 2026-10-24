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
| Reactions, polls, status server, 유비온봇 | current flags | off (no `bot.ubion.global`) |
| Updates | `ubion-messenger-releases` | none |
| Settings folder | `UBION Messenger` | `Dawer` (does not share the company profile) |

```bash
cd desktop
npm run dev                 # UBION Messenger
npm run dev:dawer           # 다워  (UBM_FLAVOR=generic)
npm run dist                # ubion installers
npm run dist:dawer          # Dawer installers, not published
```

다워 shows a one-line notice: **비공식 클라이언트**. It is not the official DaouOffice app and does not use DaouOffice branding. Icons are still the shared set until a Dawer icon is drawn.

## 자동 업데이트 / 릴리스 (v1.0.3+)

- 배포 저장소(공개, 설치 파일만): https://github.com/scottnaddle/ubion-messenger-releases
- Windows: electron-updater 로 시작 시·4시간마다 확인 → 백그라운드 다운로드 → '새 버전 설치 후 다시 시작' 또는 종료 시 설치.
- macOS(미서명): latest-mac.yml 로 새 버전 감지 → 맞는 아키텍처 dmg 를 ~/Downloads 로 받아 열기 → 응용 프로그램으로 끌어 '대치'.
- 설정: 현재 버전, '업데이트 확인', 자동 확인 토글.
- 릴리스: 버전 올리기 → commit/push → Mac 에서 `desktop/scripts/release.sh` (CI 대기·산출물 다운로드·gh release create). 토큰 불필요(gh 로그인 사용).
- 검증: `node desktop/scripts/verify-update.mjs 1.0.2`
