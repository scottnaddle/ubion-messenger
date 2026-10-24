# Google Drive and Calendar connectors (1.1.6)

내 봇 can search Drive and read the text of common documents after the user clicks **연결** in the connector gear, then summarize that text in Korean. This is a desktop OAuth public client (PKCE + loopback). The MiniMax proxy never receives Google tokens. Company mail, approval, and calendar still use the logged-in Daou session.

The desktop executes the tools. The proxy only forwards the schemas the desktop advertises.

No production client secret is in the repo. There is no committed client id. Copy the example, put your own Desktop client id on the Mac mini, and restart is not required — the app reads the file when **연결** is clicked.

## Scopes

Least-privilege read. The app can download file bytes it is allowed to see. It does not create, edit, delete, move, or share files or folders, and it does not read or wipe a whole directory.

| Connector | Scope | Tools |
| --- | --- | --- |
| Google Drive | `https://www.googleapis.com/auth/drive.readonly` | `google_drive_list`, `google_drive_read` |
| Google Calendar | `https://www.googleapis.com/auth/calendar.readonly` | `google_calendar_today` |

The app does not request `https://www.googleapis.com/auth/drive`, `https://www.googleapis.com/auth/drive.file`, or any write, delete, or share scope.

Each row consents on its own (`include_granted_scopes=false`). **연결 해제** deletes only that connector's token on this device.

## Re-consent after 1.1.5

1.1.5 asked only for `https://www.googleapis.com/auth/drive.metadata.readonly`. That grant can list names and cannot download file content. A token saved under that scope (or any token Google rejects with `insufficientPermissions` / insufficient authentication scopes) is cleared on the first `google_drive_read`, and also on `google_drive_list` if a content search is rejected. The tool returns:

`Drive 파일 내용을 읽으려면 권한을 다시 받아야 합니다. Google Drive 행에서 연결을 다시 눌러 주세요.`

Click **연결** on the Drive row once. Calendar tokens are left alone. The new consent screen asks for `drive.readonly` only.

If the stored scope is still metadata-only, a name search can still run and adds a note that content search needs **연결** again. Reading a file always requires the new scope.

## What list and read do

`google_drive_list` searches by name and, once the token has `drive.readonly`, by file text (`fullText`). Optional `mime` (`pdf`, `document`, `spreadsheet`, `presentation`, `docx`, `xlsx`, `pptx`, `text`, `csv`, `html`, or a mime type) and `folderId` narrow the query. Results are at most 8 and include id, name, mime type, modified time, and the parent folder name when one extra metadata call can resolve it. It does not download file bytes.

`google_drive_read` takes `fileId` and an optional `maxChars` (default 12000, hard max 20000). The desktop returns text and `truncated: true` when the text was cut. It does not return base64. The model should list, read the promising files, and summarize only the returned text. Several files can be read across the existing 4-round tool loop. Empty or failed extraction is not filled in.

| Kind | How text is read |
| --- | --- |
| Google Docs, Google Slides | `files.export` `text/plain` |
| Google Sheets | `files.export` `text/csv` |
| PDF | `files.get?alt=media`, then `pdf-parse` (embedded text only) |
| `text/*`, including plain, markdown, csv, html | media download; html tags are stripped |
| Word `.docx`, Excel `.xlsx`, PowerPoint `.pptx` | media download, then pure-JS OOXML text (`jszip`) |
| Images, audio, video, zip, `.doc` / `.xls` / `.ppt`, folders | structured error, no download of useless binaries |

A PDF with no embedded text (often a scan) returns `{ ok: true, text: "", note: "텍스트를 추출하지 못했습니다(스캔본일 수 있음)." }`. There is no OCR. Files larger than 20 MB are refused. Password-protected Office files may come back with an empty-text note. The app does not open a folder as a bulk download and does not delete or move one.

## Cloud Console

1. Open [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → enable **Google Drive API** and **Google Calendar API**.
2. OAuth consent screen: External or Internal. Add `drive.readonly` and `calendar.readonly`. Remove the old metadata-only Drive scope if it is still listed. If the app is in testing, add the Google account that will click **연결** as a test user.
3. Credentials → Create credentials → OAuth client ID → application type **Desktop app**.
4. Desktop clients use the loopback redirect. You do not register each random port. If the console asks for an authorized redirect URI, add `http://127.0.0.1`.
5. Copy the client id (`….apps.googleusercontent.com`). Leave the client secret out of git.

The app opens the system browser to Google, then listens on `http://127.0.0.1:<port>/callback`. The consent screen should say UBION can see Drive file content and calendar events, not change them.

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

They are stored per messenger user id and per connector. They are not written to `localStorage`, not sent to `127.0.0.1:8787`, and not shown in the renderer. Access tokens are refreshed on the next tool call when they are within 60 seconds of expiry. **연결 해제** removes that connector's record. If Google returns `invalid_grant`, or a Drive call returns insufficient scope, that Drive record is dropped and the row goes back to **나중에 연결**.

If `safeStorage` is unavailable, connect fails and nothing is written in plaintext.

## What the proxy still does

Keep the tool loop in `desktop/docs/personal-bot-proxy.md`. When `connectorStatus` for a Google row is `ready`, the model may return `google_drive_list`, `google_drive_read`, or `google_calendar_today`. The desktop runs the call. The proxy does not need a Google client id or token.

`google_calendar_today` returns today's events in the Mac's local timezone (max 12) and does not edit the calendar. If `~/ubm-room-ai-proxy/server.py` still describes Drive as list-only, update its system prompt to the 1.1.6 text in that doc.
