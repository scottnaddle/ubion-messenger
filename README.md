# Daou Messenger MVP

Slack-like local client for on-prem DaouOffice (Group Office) messenger at `coco.ubion.co.kr`.

- **Backend:** FastAPI on `http://127.0.0.1:8787` — REST proxy + raw XMPP → WebSocket
- **Frontend:** Vite + React + TypeScript (PWA-ready), served from `frontend/dist`
- **Secrets:** macOS Keychain `daou-coco` / `cwdaddy` (never logged)

See `PROTOCOL.md` for protocol details.

> 데스크톱 앱(UBION Messenger)은 `desktop/`에 있어요. 설치 파일: https://github.com/scottnaddle/ubion-messenger-releases/releases/latest

## 왜 UBION Messenger인가요?

UBION Messenger는 사내 DaouOffice 메신저를 데스크톱에서 더 쾌적하게 쓰려고 만든 클라이언트예요. 매일 쓰는 메신저니까 작은 불편함까지 하나씩 손봤어요.

### 주요 기능

- **메시지 누락 방지**: XMPP로 메시지를 실시간으로 받고, REST 동기화를 폴백으로 함께 써서 메시지를 놓칠 일이 크게 줄었어요.
- **한글 입력 문제 해결**: 한글 IME로 입력하다 Enter를 누르면 메시지가 두 번 전송되던 문제를 해결했어요.
- **읽음 확인**: 내 메시지를 읽었는지, 누가 읽었는지까지 볼 수 있어요.
- **정확한 안 읽은 메시지 수**: 배지에 실제로 안 읽은 메시지 수가 정확하게 표시돼요.
- **탭 필터**: 1:1 대화와 그룹 대화를 탭으로 나눠서 볼 수 있어요.
- **홈 탭 포털 대시보드**: 전사게시판, 결재, 알림, 메일을 한 화면에서 볼 수 있어요.
- **새 게시글 알림**: 새 글이 올라오면 OS 알림으로 알려줘요.
- **앱 내 자동 업데이트**: 새 버전이 나오면 앱 안에서 바로 업데이트할 수 있어요.
- **Windows + macOS 지원**: 두 OS 모두에서 쓸 수 있어요.
- **안전한 로그인 정보 저장**: 로그인 정보는 OS 보안 저장소에 암호화해서 저장해요.
- **트레이/독 배지**: 트레이나 독 아이콘에서도 안 읽은 메시지를 바로 확인할 수 있어요.
- **새 아이콘 (v1.0.5)**: 앱 아이콘을 새로 바꾸고, 설정 버튼은 톱니 아이콘으로 바꿨어요.
- **홈 탭 숫자 웹과 일치 + 포털 자동 로그인 (v1.0.6)**: 홈 탭의 메일/알림/결재 숫자를 DaouOffice 웹과 같은 기준으로 맞췄고, 포털 링크는 앱 안 창에서 다시 로그인 없이 열려요(설정에서 외부 브라우저 선택 가능).
- **메뉴 탭 (v1.0.7)**: 왼쪽 레일의 메뉴 탭에서 DaouOffice 전체 기능(메일·캘린더·전자결재·근태·법인공용차량 등 회사 메뉴 그대로)을 앱 안 포털 창으로 바로 열 수 있어요.

### 앞으로

기능은 앞으로도 계속 추가할 예정이에요. 지금 계획 중인 것들은 아래와 같아요.

- **홈 대시보드 확장**: 홈 탭에서 볼 수 있는 정보를 더 늘릴 예정이에요.
- **일정 연동**: 일정을 메신저 안에서 바로 확인할 수 있게 할 예정이에요.
- **AI 에이전트(Hermes) 연동**: AI 에이전트 Hermes와 연결할 예정이에요.

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
