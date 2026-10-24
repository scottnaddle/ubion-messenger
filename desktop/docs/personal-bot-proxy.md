# 내 봇 proxy contract (1.1.6)

Desktop build **1.1.6** calls this route on the Mac mini proxy. The app does not hold a MiniMax key. The proxy does **not** receive DaouOffice passwords, cookies, or session tokens, and it does not receive Google OAuth tokens. Company tools and Google tools both run in the desktop. Google setup is in `desktop/docs/google-connectors.md`.

Room AI is unchanged: `POST /v1/room-ai/run`.

## Route

`POST http://127.0.0.1:8787/v1/personal-bot/chat`

Request:

```json
{
  "userId": 7,
  "messages": [
    { "role": "user", "content": "오늘 메일 뭐 왔어?" }
  ],
  "tools": [
    {
      "name": "ubion_mail_list",
      "description": "로그인한 유비온 메일함의 최근 메일을 읽습니다. 메일을 열거나 보내지 않습니다.",
      "parameters": { "type": "object", "properties": { "folder": { "type": "string" }, "keyword": { "type": "string" }, "limit": { "type": "number" } } }
    }
  ],
  "connectorStatus": [
    { "id": "ubion-mail", "label": "회사 메일", "state": "ready" },
    { "id": "ubion-approval", "label": "결재 대기", "state": "ready" },
    { "id": "ubion-calendar", "label": "오늘 일정", "state": "ready" },
    { "id": "google-drive", "label": "Google Drive", "state": "connect-later" },
    { "id": "google-calendar", "label": "Google Calendar", "state": "connect-later" }
  ]
}
```

`messages` is only `ubm.personal-bot.v1:<userId>`. Roles:

- `user` / `assistant`: `{ role, content, toolCalls? }`
- `tool`: `{ role: "tool", toolCallId, name, content }` where `content` is the JSON string the desktop got from the user's session

`tools` is the enabled read tools. Write tools are not advertised. `connectorStatus` says what is `ready`, `off`, or `connect-later`.

Success when the model can answer:

```json
{ "reply": "받은편지함에 결재 안내 메일이 하나 있습니다." }
```

Success when the model needs a tool. Return this **instead of calling Daou yourself**:

```json
{ "toolCalls": [{ "id": "call_1", "name": "ubion_mail_list", "arguments": { "folder": "Inbox", "limit": 5 } }] }
```

`arguments` may be an object or a JSON string. If `toolCalls` is non-empty, the desktop ignores `reply` and runs the tools. It posts again with the assistant tool-call message and one `role: "tool"` result per call. Repeat until `{ "reply" }` or 4 rounds.

Failure:

- connection error or timeout (45s): `내 봇 서버에 연결하지 못했습니다.`
- HTTP status ≥ 500: `내 봇 서버가 응답하지 못했습니다.`
- any other non-200, or JSON with neither a reply nor toolCalls: `내 봇 응답을 확인하지 못했습니다.`

Do not invent tool results and do not fall back to a stub sentence.

## Model

Use **MiniMax-M3.1-Flash**. Prepend this system prompt (the desktop does not send it):

```
당신은 유비온 메신저의 개인 비서입니다. 한국어로 대화하듯 답합니다.
요청 본문의 tools와 connectorStatus를 따르세요.
tools에 있는 도구는 데스크톱이 실행합니다. 회사 도구는 로그인된 유비온 세션을 쓰고, Google 도구는 이 기기에 저장된 토큰을 씁니다. 그 도구가 있으면 연결되지 않았다고 말하지 마세요.
connectorStatus가 off 또는 connect-later인 서비스만 아직 쓸 수 없다고 말하세요. Google Drive와 Google Calendar는 연결 전에는 connect-later이고, 연결 후에는 ready입니다.
회사 데이터나 Drive 문서를 보려면 최종 답 대신 toolCalls를 반환하세요. Drive는 google_drive_list로 찾은 다음 google_drive_read로 본문을 읽고, 그 텍스트만으로 한국어로 정리·요약하세요. 여러 파일은 도구 호출을 나눠 읽습니다. 도구 결과를 지어내지 마세요.
Drive 파일을 만들거나 수정·삭제·이동·공유하지 않습니다. 메일 발송과 결재 승인/반려는 하지 않습니다.
사용자의 문장을 되풀이하거나 "메모해 두었습니다"라고만 답하지 마세요.
```

## Patch for `server.py`

Keep the MiniMax key on the proxy. Pass `tools` through to the model. If the model asks for tools, return them. Do not execute them.

```python
PERSONAL_BOT_SYSTEM = """당신은 유비온 메신저의 개인 비서입니다. 한국어로 대화하듯 답합니다.
요청 본문의 tools와 connectorStatus를 따르세요.
tools에 있는 도구는 데스크톱이 실행합니다. 회사 도구는 로그인된 유비온 세션을 쓰고, Google 도구는 이 기기에 저장된 토큰을 씁니다. 그 도구가 있으면 연결되지 않았다고 말하지 마세요.
connectorStatus가 off 또는 connect-later인 서비스만 아직 쓸 수 없다고 말하세요. Google Drive와 Google Calendar는 연결 전에는 connect-later이고, 연결 후에는 ready입니다.
회사 데이터나 Drive 문서를 보려면 최종 답 대신 toolCalls를 반환하세요. Drive는 google_drive_list로 찾은 다음 google_drive_read로 본문을 읽고, 그 텍스트만으로 한국어로 정리·요약하세요. 여러 파일은 도구 호출을 나눠 읽습니다. 도구 결과를 지어내지 마세요.
Drive 파일을 만들거나 수정·삭제·이동·공유하지 않습니다. 메일 발송과 결재 승인/반려는 하지 않습니다.
사용자의 문장을 되풀이하거나 "메모해 두었습니다"라고만 답하지 마세요."""

@app.post("/v1/personal-bot/chat")
def personal_bot_chat(body: dict):
    # body["messages"] may include role "tool" results from the desktop.
    # body["tools"] is the advertised schema. Do not call Daou from here.
    result = minimax_chat(
        model="MiniMax-M3.1-Flash",
        system=PERSONAL_BOT_SYSTEM,
        messages=body.get("messages") or [],
        tools=body.get("tools") or [],
    )
    if result.tool_calls:
        return {"toolCalls": result.tool_calls}  # [{id, name, arguments}]
    return {"reply": result.text}
```

`minimax_chat` is the helper `/v1/room-ai/run` already uses. Map its tool-call objects to `{ id, name, arguments }`.

## Connector registry

Defined in `desktop/src/lib/connectors.ts`. Per-user toggles: `ubm.personal-bot.connectors.v1:<userId>`.

| id | state by default | advertised read tool | notes |
| --- | --- | --- | --- |
| `ubion-mail` | ready | `ubion_mail_list` | Inbox list via the logged-in session. `ubion_mail_send` exists but is a gated write and is not advertised. |
| `ubion-approval` | ready | `ubion_approval_list` | `todo` or `upcoming` only. No approve/reject. |
| `ubion-calendar` | ready | `ubion_calendar_today` | Today's Daou calendar. |
| `google-drive` | connect-later until **연결** | `google_drive_list` and `google_drive_read` when the row is `ready` | Desktop PKCE. List, then read text, then summarize. No create, edit, delete, move, or share. Toggle off sets `off`. |
| `google-calendar` | connect-later until **연결** | `google_calendar_today` when the row is `ready` | Same. Read-only. |

Google refresh tokens stay in the desktop safe store (`google-connectors.bin`). They are not placed in `ubm.personal-bot.connectors.v1:<userId>` and they are not posted to this route. The proxy only advertises the schemas the desktop sends. `executePersonalBotTool`'s `extra` map runs `google_drive_list`, `google_drive_read`, and `google_calendar_today` on the desktop. See `desktop/docs/google-connectors.md` for scopes and the Cloud Console client id.

The file `~/ubm-room-ai-proxy/server.py` on the Mac mini is not in this repo. If its `PERSONAL_BOT_SYSTEM` still says Google tools are list-only, replace it with the prompt above so the model searches, reads file text, and does not claim it can create, edit, delete, move, or share Drive files. Restart the proxy after that edit, then rebuild the Mac app at **1.1.6**. The proxy does not need a Google client id.
