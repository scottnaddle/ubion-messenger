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
