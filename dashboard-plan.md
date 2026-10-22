# UBION Messenger — 포털 대시보드(홈) 기획

작성: 2026-10-22 (KST) · 대상: coco.ubion.co.kr (DaouOffice classic Group Office)
근거: Scott Mac에서 읽기 전용 GET 정찰(로그인 1회, 쿠키 jar 재사용, 임시파일 삭제). 실제 본문/이름/제목은 기록하지 않음.

## 1. 목표
- 메신저를 떠나지 않고 포털 홈(`/app/home`)의 핵심 정보(전사게시판 최근글, 결재 대기, 오늘 메일/일정, 알림 등)를 확인.
- 결재·메일·알림은 **배지**로 상시 노출, 새 전사 공지는 **데스크톱 알림**(선택).
- 항목 클릭 시 웹 원문으로 바로 이동(딥링크). 쓰기 동작(결재·댓글·좋아요·읽음처리)은 메신저에서 하지 않음 → 웹으로 위임.

## 2. 사용자 시나리오
1. 출근해 메신저 실행 → '홈' 탭에서 오늘 일정 수·결재 대기·안 읽은 알림·전사게시판 새 글을 한눈에.
2. 대화 중 레일의 '홈' 아이콘에 결재 배지(3) → 클릭 → 결재 카드에서 문서 클릭 → 인앱 웹뷰(세션 공유)로 결재 화면 열림.
3. 전사게시판에 새 글 → OS 알림 "전사게시판: 새 글" → 클릭 시 게시물 웹 페이지.
4. 생일자 카드에서 동료 클릭 → 기존 메신저 프로필/1:1 대화 열기(메신저 고유 가치).

## 3. 포털 홈 구조 (정찰 결과)
- 포털 홈 = **대시보드 + 가젯(gadget)** 구조. `GET /api/dashboard` → 대시보드 3개(COMPANY 1, USER 2; `activated`로 현재 사용 여부).
- `GET /api/dashboard/{id}/gadget` → 가젯 배열: `id,type,spec{id,name,script,...},boxNumber,boxOrder,options,actions`.
  `spec.script`에 가젯 JS가 통째로 들어있고, 그 안에서 호출하는 API가 아래 엔드포인트들임.
- 현재 회사 대시보드 가젯 10종: 투데이 프로필, 근태관리, 캘린더, 전자결재 문서함, 작성할 보고, Quick Menu, 가입 커뮤니티, 생일, 메일 리스트, 전사게시판 최근글.
- `options`(JSON 문자열)에 가젯별 설정(offset, refresh 초, boardIds, approvalType 등) → 메신저 위젯 기본값으로 재사용 가능.

## 4. 확인된 엔드포인트 (모두 GOSSOcookie 세션, GET, 응답 래퍼 `{code,message,data,page?}`)
| 기능 | 엔드포인트 | 주요 필드 | 확인 |
|---|---|---|---|
| 대시보드 목록 | `/api/dashboard` | id,title,type,layout,boxCount,activated | 200, 3건 |
| 가젯 목록 | `/api/dashboard/{id}/gadget` | spec{id,name,script}, boxNumber, boxOrder, options | 200, 10건 |
| **오늘 요약(배지 원천)** | `/api/user/today` | data.profile{…}, data.summaries[]{appName,gadgetName,count} — mail/approval/approval2/community/calendar/asset/board/report/survey 9종 | 200 |
| 전사게시판 최근글 | `/api/board/posts/company?offset=5&page=0` | id,createdAt,boardId,boardName,type,status,summary,recommendCount,commentsCount,hasAttach,writer{…}; page{total…} | 200, 5건 |
| 특정 게시판 글 | `/api/board/{boardId}/posts?offset=&page=` | 위와 동일(가젯 코드 기준) | 미호출(동형) |
| 게시판 목록 | `/api/company/boards/ACTIVE?page=0&offset=1000` | id,board{id,name,lastPostedAt,postCount,homeExposureFlag,type},nodeType,parentId | 200, 47건 |
| 게시판(권한 포함) | `/api/board/company/boardsWithIp` | data.boards[]{board,actions,…} | 200, 37건 |
| 가젯용 게시판 정보 | `/api/board/gadget?boardId=…` | (가젯 코드 기준) | 미호출 |
| 결재 대기 | `/api/approval/todo?page=0&offset=5` | page.total, data[]{id,documentId,formName,title,docStatus,apprStatus,…} | 200, 0건 |
| 결재 예정 | `/api/approval/upcoming?page=0&offset=5` | 동일 | 200, 1건 |
| 결재 대기 수 | `/api/approval/todo/count` | data{docCount,…} | 200 |
| (기타 문서함) | `/api/approval/doclist/{draft|approve|viewer…}/all` | 동일 | 미호출 |
| 메일 목록 | `/api/mail/message/gadget?count=5` | data.messageList[]{id,folderName,folderFullName,subject,name,dateUtc,seen,priority}, pageInfo{total…} | 200, 5건 |
| 메일 수 | `/api/mail/message/count[?today=on]` | data(숫자) | 200 (웹은 POST 사용, GET도 동작) |
| 메일 폴더 | `/api/mail/folder/all` | defaultFolders,userFolders | 미호출 |
| 포털 알림 | `/api/my/noti`, `/api/my/noti/unread?page=0&offset=N` | id,category(approval/bbs/calendar…),sender,profile,message,createdAt,linkUrl(`/link/noti/{id}`); page.total=미읽음 수 | 200 |
| 공지(상단 팝업) | `/api/notice/normal` | data[] | 200, 0건 |
| 생일 | `/api/user/birthdaylist?date=YYYY-MM-DD&page=0&offset=5&type=init` | content[]{userId,birthday,solarBirthday,lunarCal,name,position}, pageInfo | 200, 5건 |
| 작성할 보고 | `/api/report/undone` | data[] | 200, 0건 |
| 커뮤니티 | `/api/community/list/menu` | id,name,memberStatus,postCount,newPostCount | 200, 2건 |
| 설문(진행중) | `/api/survey/list/progress` | page, data[] | 200, 0건 |
| 할 일(ToDo 보드) | `/api/todo/my` | id,title,owner{…},members,labels,favoriteFlag | 200, 4건 |
| 내 예약 | `/api/asset/my/reservation` | assetName,itemName,reservedStartTime,reservedEndTime,recurrence | 200, 37건(과거 포함 → 클라 필터) |
| 근태 요약 | `/api/ehr/timeline/summary`, `/info` | group{workingType,…} | 200 (출퇴근 POST류는 사용 금지) |
| 일정(오늘) | `/api/calendar/user/me/event/daily?year=&month=` | — | **500**: 파라미터 미확정 → Phase 2에서 캘린더 앱 모듈 분석. MVP는 `user/today` calendar count 사용 |

신규 사원 전용 API는 가젯에 없음(미발견). 필요 시 `/api/users/accessible/entire` 의 입사일 필드 여부 확인 필요.

### 딥링크 (웹 원문 열기)
- 게시물: `/app/board/{boardId}/post/{postId}` (CLASSIC), `/app/board/{boardId}/post/{postId}/stream` (STREAM), 그 외 `/app/board/{boardId}`
- 결재 문서: `/app/approval/document/{id}`
- 메일: `/app/mail?work=read&folder={folderFullName}&uid={id}`
- 알림: `linkUrl` (`/link/noti/{id}` → 서버 리다이렉트; **열면 읽음 처리될 가능성** → 사용자 클릭 시에만 열기)
- 앱 홈: `/app/{appName}` (calendar, survey, todo, asset, report, community …)

## 5. 권장 UX
- 좌측 레일 최상단에 **'홈'** 탭 추가(대화/조직도 위). 레일 아이콘 배지 = 결재 대기 + 미읽음 알림.
- 홈 화면 = 2열 카드 그리드(창 폭 좁으면 1열). 카드 헤더에 제목·건수·새로고침·"웹에서 보기".
- 상단 요약 스트립: `user/today.summaries` 칩(오늘 메일 · 결재 · 일정 · 예약 · 설문 · 보고).
- 클릭 동작(설정에서 선택): ① 인앱 웹뷰 창(기본, 세션 공유) ② 외부 브라우저.
- 알림 옵션: "전사게시판 새 글 알림", "결재 도착 알림"(기본 ON), 방해금지 시간 존중.
- 트레이 메뉴/독 배지에 결재 수 합산(선택).

```
┌────┬─────────────────────────────────────────────────────────┐
│ 🏠3│  홈                                     ⟳  마지막 11:30  │
│ 💬 │  [메일 2] [결재 3] [일정 1] [예약 0] [설문 0] [보고 0]    │
│ 👥 │ ┌─ 전사게시판 최근글 ───── 웹 ▸┐ ┌─ 결재 대기 (3) ─── 웹 ▸┐ │
│    │ │ • [게시판] 요약…   💬2 📎     │ │ • [양식] 제목…   긴급   │ │
│    │ │ • …                           │ │ • …                     │ │
│    │ └───────────────────────────────┘ └─────────────────────────┘ │
│    │ ┌─ 알림 (미읽음 15) ───────────┐ ┌─ 메일 (안읽음) ────────┐ │
│    │ │ [결재] … 5분 전               │ │ ● 보낸이 · 제목…        │ │
│    │ └───────────────────────────────┘ └─────────────────────────┘ │
│ ⚙  │ ┌─ 오늘 생일 🎂 ──┐ ┌─ 내 예약 ──┐ ┌─ 커뮤니티 새글 ─┐       │
└────┴─────────────────────────────────────────────────────────┘
```

## 6. 위젯 우선순위
| 단계 | 위젯 | 엔드포인트 |
|---|---|---|
| MVP | 요약 스트립 + 레일 배지 | `/api/user/today`, `/api/approval/todo/count`, `/api/my/noti/unread?offset=1`(page.total) |
| MVP | 전사게시판 최근글 (+새 글 알림) | `/api/board/posts/company` |
| MVP | 결재 대기/예정 | `/api/approval/todo`, `/api/approval/upcoming` |
| MVP | 포털 알림 목록 | `/api/my/noti` |
| MVP | 메일(최근/안읽음) | `/api/mail/message/gadget`, `/api/mail/message/count` |
| Phase 2 | 게시판 선택 위젯(즐겨찾는 게시판) | `/api/company/boards/ACTIVE`, `/api/board/{id}/posts` |
| Phase 2 | 오늘 일정 | calendar API 파라미터 확정 후 |
| Phase 2 | 생일(→메신저 대화 연결) | `/api/user/birthdaylist` |
| Phase 2 | 내 예약, 설문, 작성할 보고, 커뮤니티 새글, 공지 팝업 | `/api/asset/my/reservation`, `/api/survey/list/progress`, `/api/report/undone`, `/api/community/list/menu`, `/api/notice/normal` |
| Later | ToDo, 근태(조회만), 서버 대시보드 레이아웃 그대로 미러링 | `/api/todo/my`, `/api/ehr/timeline/summary`, `/api/dashboard/{id}/gadget` |

## 7. 데이터 갱신 전략
- 홈 탭 활성 + 창 포커스: 60초(가젯 기본 refresh=60 기준). 비활성/백그라운드: 배지용 경량 호출만 3~5분.
- 경량 폴링 세트: `user/today` + `approval/todo/count` + `my/noti/unread?offset=1` + `board/posts/company?offset=5`(새 글 감지: 최대 `id` 비교, 로컬 저장).
- 실시간 보조: 웹은 BOSH(`go-notification`)로 포털 알림 푸시를 받음. Phase 3에서 기존 XMPP 연결에 해당 알림 스트림이 오는지 확인 → 오면 폴링 주기 확대.
- 포커스 복귀·수동 새로고침 시 즉시 갱신, 실패 시 지수 백오프(최대 10분). 401 → 기존 `refreshSession()` 재로그인 경로 재사용(로그인 남발 금지).
- 동일 데이터 동시 요청 dedupe, 응답 캐시(메모리) 후 렌더러에 diff 이벤트.

## 8. messenger-core 통합
- `desktop/electron/core/portal.ts` 신설: `PortalService`(DaouClient의 `getJson` 재사용, 읽기 전용 GET만 허용하는 화이트리스트).
  - 메서드: `summary()`, `companyPosts(n)`, `boardPosts(id,n)`, `approvals(type,n)`, `approvalCount()`, `notis(n)`, `unreadNotiCount()`, `mails(n)`, `birthdays(date)`, `reservations()`…
  - `types.ts`에 `PortalSummary`, `BoardPost`, `ApprovalDoc`, `PortalNoti`, `MailItem` 추가(필요 필드만 매핑).
- `MessengerCore`에 `portal` 포함 + 이벤트: `portalSummary`, `portalWidget {id,data}`, `portalNewPost {boardId,postId}`, `portalBadge {approval,noti,mail}`.
- main ↔ renderer: preload에 `portal.get(widgetId)`, `portal.refresh()`, `portal.open(url, mode)` IPC.
- 렌더러: `src/components/Home.tsx` + 위젯 카드 컴포넌트, `lib/badge.ts`에 결재/알림 합산.
- 설정(`settings.ts`): 위젯 on/off·순서, 클릭 동작(웹뷰/외부), 알림 토글, 선택 게시판 ID.

## 9. 웹뷰 세션 공유
- Electron `session.fromPartition('persist:coco')`에 core가 가진 `GOSSOcookie`를 `cookies.set`으로 주입 → `BrowserWindow`로 딥링크 로드. 쿠키는 메인 프로세스에서만 다루고 렌더러 노출 금지.
- 웹뷰는 `contextIsolation`, `nodeIntegration:false`, 도메인 coco.ubion.co.kr 외 링크는 외부 브라우저로.
- 외부 브라우저 모드는 세션 미공유 → 사용자가 웹에 별도 로그인 필요(안내 문구).

## 10. 리스크
- **세션 충돌**: 웹뷰 내 로그아웃/만료가 core 세션에 영향 가능. 동일 쿠키 공유 시 서버가 동시 세션을 허용하는지 확인 필요.
- **권한/정보노출**: 응답에 개인정보(프로필, 메일 제목) 포함 → 로컬 캐시 최소화, 디스크 저장 금지(새 글 감지용 id만 저장).
- **부작용**: `/link/noti/{id}` 열람, 게시물/결재 상세 조회는 읽음 처리될 수 있음 → 사용자 클릭 시에만. 메일 count는 웹에서 POST로 호출 — GET 동작 확인됨, GET 사용.
- **서버 부하**: 사용자 수 × 폴링. 경량 세트·백오프·포커스 기반 조절로 웹 포털 대비 낮게 유지.
- **비공개 API 변경**: 서버 업그레이드 시 경로 변경 가능 → 실패 시 카드 단위로 "웹에서 보기"로 degrade.
- 캘린더 일정 API 미확정(500), 신규 입사자 API 미발견.
- IP 제한: 사내/VPN에서만 동작(기존과 동일).

## 11. 일정 추정 (1인 기준)
| 단계 | 범위 | 공수 |
|---|---|---|
| Phase 0 | 캘린더 파라미터·noti 푸시 경로 추가 정찰, 타입 정의 | 0.5~1일 |
| Phase 1 (MVP) | PortalService, 홈 탭+5개 카드, 배지, 새 글 알림, 웹뷰/외부 열기, 설정 | 4~5일 |
| Phase 2 | 게시판 선택, 일정, 생일→대화, 예약/설문/보고/커뮤니티/공지 | 3~4일 |
| Phase 3 | 실시간 알림 연동, 위젯 순서 드래그, 서버 대시보드 미러링, 트레이 요약 | 3~5일 |
| QA | 세션 만료·오프라인·권한 없는 게시판 케이스 | 1~2일 |
