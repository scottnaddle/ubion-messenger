# 내 봇 proxy contract (1.1.2)

Desktop build **1.1.2** calls this route on the Mac mini proxy. The app does not hold a MiniMax key and does not fall back to the stub when the call fails.

Room AI is unchanged: `POST /v1/room-ai/run`.

## Route

`POST http://127.0.0.1:8787/v1/personal-bot/chat`

Request:

```json
{
  "userId": 7,
  "messages": [
    { "role": "user", "content": "오늘 일정 있어?" },
    { "role": "assistant", "content": "일정은 아직 연결 전입니다. 시간만 메모해 두실 내용을 말씀해 주세요." },
    { "role": "user", "content": "내일 오전으로 잡아줘" }
  ]
}
```

`messages` is the personal-bot session only (`ubm.personal-bot.v1:<userId>`). It is not the 유비온봇 DM and not the 나 room. Roles are `user` or `assistant`. There is no `system` field. The desktop omits its local greeting and any `[스텁]` lines.

Success `200`:

```json
{ "reply": "일정은 아직 연결 전이라 캘린더에 넣지는 못합니다. 내일 오전으로 기억해 두고, 연결되면 그때 잡아드릴게요." }
```

`reply` must be a non-empty string. The desktop shows it as the assistant bubble.

Failure:

- connection error or timeout (45s): desktop shows `내 봇 서버에 연결하지 못했습니다.`
- HTTP status ≥ 500: `내 봇 서버가 응답하지 못했습니다.`
- any other non-200, or JSON without a non-empty `reply`: `내 봇 응답을 확인하지 못했습니다.`

Do not answer those with a stub sentence. The desktop will not replace them.

## Model

Use **MiniMax-M3.1-Flash**, the same MiniMax client as `/v1/room-ai/run`. Prepend this system prompt (the desktop does not send it):

```
당신은 유비온 메신저의 개인 비서입니다. 한국어로 대화하듯 답합니다.
메일, 전자결재, 일정은 아직 연결되어 있지 않습니다. 그 기능을 물으면 아직 연결 전이라고 짧게 말하고, 이어서 지금 도울 수 있는 범위를 안내합니다.
사용자의 문장을 되풀이하거나 "메모해 두었습니다"라고만 답하지 마세요.
```

## Patch for `server.py`

Reuse the existing MiniMax call. Shape only:

```python
PERSONAL_BOT_SYSTEM = """당신은 유비온 메신저의 개인 비서입니다. 한국어로 대화하듯 답합니다.
메일, 전자결재, 일정은 아직 연결되어 있지 않습니다. 그 기능을 물으면 아직 연결 전이라고 짧게 말하고, 이어서 지금 도울 수 있는 범위를 안내합니다.
사용자의 문장을 되풀이하거나 "메모해 두었습니다"라고만 답하지 마세요."""

@app.post("/v1/personal-bot/chat")
def personal_bot_chat(body: dict):
    messages = body.get("messages") or []
    # messages: [{ "role": "user" | "assistant", "content": str }, ...]
    # Do not read the 유비온봇 DM or the 나 room.
    reply = minimax_chat(
        model="MiniMax-M3.1-Flash",
        system=PERSONAL_BOT_SYSTEM,
        messages=messages,
    )
    return {"reply": reply}
```

`minimax_chat` means whatever helper `/v1/room-ai/run` already uses. Point it at MiniMax-M3.1-Flash and return the assistant text as `reply`.
