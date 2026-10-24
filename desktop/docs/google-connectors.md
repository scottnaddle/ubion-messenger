# Google Drive and Calendar connectors (1.1.4)

내 봇 can list Drive files and today's Google Calendar after the user clicks **연결** in the connector gear. This is a desktop OAuth public client (PKCE + loopback). The MiniMax proxy never receives Google tokens. Company mail, approval, and calendar still use the logged-in Daou session.

No production client secret is in the repo. There is no committed client id. Copy the example, put your own Desktop client id on the Mac mini, and restart is not required — the app reads the file when **연결** is clicked.

## Scopes

Least-privilege read. The app does not request send, upload, or delete.

| Connector | Scope | Tool |
| --- | --- | --- |
| Google Drive | `https://www.googleapis.com/auth/drive.metadata.readonly` | `google_drive_list` |
| Google Calendar | `https://www.googleapis.com/auth/calendar.readonly` | `google_calendar_today` |

Each row consents on its own (`include_granted_scopes=false`). **연결 해제** deletes only that connector's token on this device.

## Cloud Console

1. Open [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → enable **Google Drive API** and **Google Calendar API**.
2. OAuth consent screen: External or Internal. Add the two scopes above. If the app is in testing, add the Google account that will click **연결** as a test user.
3. Credentials → Create credentials → OAuth client ID → application type **Desktop app**.
4. Desktop clients use the loopback redirect. You do not register each random port. If the console asks for an authorized redirect URI, add `http://127.0.0.1`.
5. Copy the client id (`….apps.googleusercontent.com`). Leave the client secret out of git.

The app opens the system browser to Google, then listens on `http://127.0.0.1:<port>/callback`. The consent screen should say UBION can see Drive file metadata and calendar events, not change them.

## Where to put the client id

Resolution order:

1. Environment variable `UBM_GOOGLE_CLIENT_ID` (optional `UBM_GOOGLE_CLIENT_SECRET` only if refresh returns `invalid_client`).
2. `UBM_GOOGLE_OAUTH_FILE`, if set, pointing at a JSON file.
3. Otherwise the userData file:

macOS: `~/Library/Application Support/UBION Messenger/google-oauth.json`

```json
{
  "clientId": "1234567890-abcdef.apps.googleusercontent.com"
}
```

`desktop/google-oauth.example.json` is a placeholder. `YOUR_CLIENT_ID` is rejected on purpose.

A Desktop client sometimes still has a secret in the console. Do not commit it. If token refresh fails with `invalid_client`, add `"clientSecret"` to that same local JSON (or `UBM_GOOGLE_CLIENT_SECRET`). The authorize URL never includes the secret. PKCE (`S256`) is always sent.

## Tokens

Refresh and access tokens are encrypted with Electron `safeStorage` (macOS Keychain) at:

`~/Library/Application Support/UBION Messenger/google-connectors.bin`

They are stored per messenger user id and per connector. They are not written to `localStorage`, not sent to `127.0.0.1:8787`, and not shown in the renderer. Access tokens are refreshed on the next tool call when they are within 60 seconds of expiry. **연결 해제** removes that connector's record. If Google returns `invalid_grant`, the record is dropped and the row goes back to **나중에 연결**.

If `safeStorage` is unavailable, connect fails and nothing is written in plaintext.

## What the proxy still does

Keep the 1.1.3 tool loop in `desktop/docs/personal-bot-proxy.md`. When `connectorStatus` for a Google row is `ready`, the model may return `google_drive_list` or `google_calendar_today`. The desktop runs the call. The proxy does not need a Google client id or token.

`google_drive_list` returns file id, name, mime type, and modified time (max 8). `google_calendar_today` returns today's events in the Mac's local timezone (max 12). Neither downloads file bytes or edits the calendar.
