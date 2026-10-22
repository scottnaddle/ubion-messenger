# Daou Messenger MVP

Slack-like local client for on-prem DaouOffice (Group Office) messenger at `coco.ubion.co.kr`.

- **Backend:** FastAPI on `http://127.0.0.1:8787` — REST proxy + raw XMPP → WebSocket
- **Frontend:** Vite + React + TypeScript (PWA-ready), served from `frontend/dist`
- **Secrets:** macOS Keychain `daou-coco` / `cwdaddy` (never logged)

See `PROTOCOL.md` for protocol details.

## One-command run (Scott’s Mac)

```bash
~/daou-app/scripts/run.sh
```

Then open **http://127.0.0.1:8787/**

Optional:
```bash
DAOU_PORT=8787 ~/daou-app/scripts/run.sh
```

## Safety

- Send is implemented but blocked unless the room is **self-chat** (`buddySeq == me`) or you confirm in the UI (`confirmSelf`).
- MVP does **not** call mark-as-read (`…/before`) endpoints.
- Presence is only what connecting requires (`online:on`).

## Dev notes

- Build UI on a machine with disk: `cd frontend && npm i && npm run build`
- Sync `frontend/dist` to the Mac; do not copy `node_modules`.
- Later wrap with Tauri pointing at the same localhost backend (or embed it).
