// Synthetic fixtures shaped like dashboard-plan.md §4 (no real data).
export const today = { code: "200", message: "OK", data: { profile: { name: "테스트" }, summaries: [
  { appName: "mail", gadgetName: "메일", count: 2 }, { appName: "approval", gadgetName: "결재", count: 3 },
  { appName: "calendar", gadgetName: "일정", count: "1" }, { appName: "survey", gadgetName: "설문", count: null } ] } };
export const companyPosts = { code: "200", message: "OK", page: { total: 42, page: 0, offset: 5 }, data: [
  { id: 905, createdAt: "2026-10-22T09:00:00.000+09:00", boardId: 7, boardName: "공지", type: "CLASSIC", status: "OPEN", summary: "공지 A", recommendCount: 0, commentsCount: 2, hasAttach: true, writer: { id: 1, name: "관리자" } },
  { id: 904, createdAt: "2026-10-21T09:00:00.000+09:00", boardId: 8, boardName: "소식", type: "STREAM", status: "OPEN", summary: "소식 B", recommendCount: 1, commentsCount: 0, hasAttach: false, writer: { id: 2, name: "홍" } } ] };
export const approvalTodo = { code: "200", message: "OK", page: { total: 3 }, data: [
  { id: 501, documentId: 501, formName: "지출결의서", title: "정산", docStatus: "INPROGRESS", apprStatus: "WAIT", isEmergency: true } ] };
export const approvalUpcoming = { code: "200", message: "OK", page: { total: 0 }, data: [] };
export const approvalCount = { code: "200", message: "OK", data: { docCount: 3, refCount: 0 } };
export const noti = { code: "200", message: "OK", page: { total: 15 }, data: [
  { id: 77, category: "approval", sender: { name: "김" }, profile: "", message: "<b>결재</b> 요청", createdAt: "2026-10-22T10:00:00+09:00", linkUrl: "/link/noti/77" },
  { id: 78, category: "bbs", sender: { name: "이" }, message: "새 글", createdAt: "2026-10-22T10:01:00+09:00", linkUrl: "https://evil.example/x" } ] };
export const mail = { code: "200", message: "OK", data: { messageList: [
  { id: 1201, folderName: "받은편지함", folderFullName: "Inbox", subject: "회의", name: "박", dateUtc: 1761100000000, seen: false, priority: "3" },
  { id: 1200, folderName: "업무", folderFullName: "Inbox/업무 A", subject: "보고", name: "최", dateUtc: 1761000000000, seen: true } ], pageInfo: { total: 120 } } };
export const mailCount = { code: "200", message: "OK", data: 4 };
// ---- Live-shaped fixtures (coco.ubion.co.kr, 2026-10-22, values anonymized only where personal) ----
/** user/today as returned live: mail count 0 (web replaces it), board with empty gadgetName (web never shows it). */
export const todayLive = { code: "200", message: "OK", data: { profile: { name: "테스트" }, summaries: [
  { appName: "mail", gadgetName: "오늘 온 메일", count: 0 }, { appName: "approval", gadgetName: "결재할 문서", count: 0 },
  { appName: "approval2", gadgetName: "결재 수신 문서", count: 0 }, { appName: "community", gadgetName: "내 커뮤니티 새글", count: 0 },
  { appName: "calendar", gadgetName: "오늘의 일정", count: 0 }, { appName: "asset", gadgetName: "내 예약/대여 현황", count: 0 },
  { appName: "board", gadgetName: "", count: 5 }, { appName: "report", gadgetName: "작성할 보고", count: 0 },
  { appName: "survey", gadgetName: "참여할 설문", count: 0 } ] } };
/** GET /api/mail/message/count (no params) = whole mailbox total — NOT what the web shows. */
export const mailCountTotal = { code: "200", message: "OK", data: 11530 };
/** GET /api/mail/message/count?today=on = web "오늘 온 메일". */
export const mailCountToday = { code: "200", message: "OK", data: 37 };
/** GET /api/home/noti/count = web top-bar unread noti count. */
export const homeNotiCount = { code: "200", message: "OK", data: 862 };
/** /api/my/noti/unread live: page.total is 0 although items exist (useless as a count). */
export const notiUnreadLive = { code: "200", message: "OK", page: { page: 0, offset: 1, total: 0, totalPage: 0, lastPage: false }, hasNext: true,
  data: [{ id: 17571129, category: "approval", sender: "진", message: "[댓글 등록] 댓글이 등록되었습니다.", createdAt: "2026-10-21T13:14:39.348+09:00", linkUrl: "/link/noti/17571129" }] };
export const approvalCountLive = { code: "200", message: "OK", data: { documentId: 0, docCount: 0, readable: true } };
