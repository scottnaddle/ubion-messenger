/** Mock bridge for headless UI screenshots / browser preview (only when window.ubion is absent). Fake data only. */
import type { Bridge } from "./api";

export function installMockIfNeeded() {
  if ((window as any).ubion) return;
  const now = Date.now();
  const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const me = { id: 1, repId: 1, name: "홍길동", loginId: "hong", companyId: 1, position: "매니저" };
  const svg = (c: string, t: string) =>
    "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='560' height='360'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${c}'/><stop offset='1' stop-color='#1d2b4f'/></linearGradient></defs><rect width='560' height='360' fill='url(#g)'/><circle cx='430' cy='90' r='46' fill='#ffd36b'/><path d='M0 300 L170 170 L290 270 L380 200 L560 330 L560 360 L0 360z' fill='#ffffff55'/><text x='28' y='336' font-size='22' fill='#fff' font-family='sans-serif'>${t}</text></svg>`);
  const rooms = [
    { key: "buddy:2", kind: "buddy", seq: 2, name: "김하늘", position: "책임", preview: "네, 오후 3시에 회의실에서 봬요!", unread: 2, createdAt: iso(2), usePin: true, usePush: true, avatar: "", isSelf: false, peerUserId: 2 },
    { key: "room:10", kind: "room", seq: 10, name: "프로젝트 알파 TF", memberCount: 6, preview: "📎 화면설계_v3.pdf", unread: 5, createdAt: iso(9), usePin: false, usePush: true, avatar: "", isSelf: false },
    { key: "buddy:3", kind: "buddy", seq: 3, name: "이서준", position: "선임", preview: "배포 완료했습니다 🙌", unread: 0, createdAt: iso(40), usePin: false, usePush: true, avatar: "", isSelf: false, peerUserId: 3 },
    { key: "room:11", kind: "room", seq: 11, name: "개발본부 공지", memberCount: 42, preview: "다음 주 서버 점검 일정 안내드립니다.", unread: 0, createdAt: iso(180), usePin: false, usePush: false, avatar: "", isSelf: false },
    { key: "buddy:4", kind: "buddy", seq: 4, name: "박지우", position: "수석", preview: "자료 감사합니다.", unread: 0, createdAt: iso(60 * 26), usePin: false, usePush: true, avatar: "", isSelf: false, peerUserId: 4 },
    { key: "buddy:5", kind: "buddy", seq: 5, name: "최유나", position: "주임", preview: "내일 출장 일정 공유드려요", unread: 0, createdAt: iso(60 * 50), usePin: false, usePush: true, avatar: "", isSelf: false, peerUserId: 5 },
    { key: "pubsub:7", kind: "pubsub", seq: 7, name: "전사 알림", preview: "10월 사내 행사 안내", unread: 1, createdAt: iso(60 * 72), usePin: false, usePush: true, avatar: "", isSelf: false },
    { key: "buddy:1", kind: "buddy", seq: 1, name: "홍길동", preview: "메모: 주간보고 초안", unread: 0, createdAt: iso(60 * 24 * 9), usePin: false, usePush: true, avatar: "", isSelf: true, peerUserId: 1 },
  ];
  const msgs = [
    { messageId: 101, sendUserSeq: 2, sendUserName: "김하늘", message: "안녕하세요! 내일 디자인 리뷰 자료 공유드릴게요.", createdAt: iso(60 * 25), userImage: "" },
    { messageId: 102, sendUserSeq: 1, sendUserName: "홍길동", message: "좋습니다 👍 리뷰 전에 한 번 훑어볼게요.", createdAt: iso(60 * 25 - 2), userImage: "" },
    { messageId: 103, sendUserSeq: 2, sendUserName: "김하늘", message: "", messageType: "SENDFILE", createdAt: iso(30), userImage: "",
      attach: { cryptId: "x", name: "메인화면_시안.png", size: 482133, imageFile: true, thumbMid: svg("#4f7cff", "메인화면 시안 v3"), thumbOriginal: svg("#4f7cff", "메인화면 시안 v3") } },
    { messageId: 104, sendUserSeq: 2, sendUserName: "김하늘", message: "다크 모드 색상도 같이 반영했어요.\n피드백 주시면 바로 수정하겠습니다.", createdAt: iso(29), userImage: "" },
    { messageId: 105, sendUserSeq: 1, sendUserName: "홍길동", message: "", messageType: "SENDFILE", createdAt: iso(12), userImage: "", needConfirmCount: 0,
      attach: { cryptId: "y", name: "요구사항정의서_v2.docx", size: 1832000, expiresAt: "2027-10-23T14:59:59.000Z" } },
    { messageId: 1051, sendUserSeq: 2, sendUserName: "김하늘", message: "", messageType: "SENDFILE", createdAt: iso(11.8), userImage: "",
      attach: { cryptId: "v", name: "시연영상.mp4", size: 84 * 1024 * 1024, videoThumb: svg("#d6336c", "시연영상"), duration: 95, expiresAt: "2027-10-23T14:59:59.000Z" } },
    { messageId: 1052, sendUserSeq: 2, sendUserName: "김하늘", message: "", messageType: "SENDFILE", createdAt: iso(11.6), userImage: "",
      attach: { cryptId: "z", name: "지난분기_실적.xlsx", size: 80 * 1024 * 1024, expiresAt: "2025-01-01T00:00:00.000Z" } },
    { messageId: 106, sendUserSeq: 1, sendUserName: "홍길동", message: "요구사항 문서 최신본입니다. 오후 회의 때 같이 봐요. https://example.com/wiki", createdAt: iso(11), userImage: "", needConfirmCount: 1 },
    { messageId: 107, sendUserSeq: 2, sendUserName: "김하늘", message: "네, 오후 3시에 회의실에서 봬요!", createdAt: iso(2), userImage: "" },
  ];
  const users = [2, 3, 4, 5, 6, 7].map((id, i) => ({
    userId: id, name: ["김하늘", "이서준", "박지우", "최유나", "정도윤", "한소희"][i], position: ["책임", "선임", "수석", "주임", "책임", "선임"][i],
    email: `user${id}@example.com`, thumbnail: "", departmentIds: [i % 2 ? 20 : 21],
  }));
  const mockSettings: any = { serverUrl: "https://coco.ubion.co.kr", username: "hong", rememberMe: true, autoLogin: true, theme: new URLSearchParams(location.search).get("theme") || "light", notifications: true, notificationPreview: true, notificationSound: true, launchAtLogin: false, closeToTray: true, downloadDir: "", askSaveLocation: false, fontSize: 14, autoUpdate: true, portalPostNotify: true, portalOpenMode: "inapp", hasSavedPassword: true };
  const mockSaved: Record<string, number> = {};
  const handlers: Record<string, (...a: any[]) => any> = {
    "settings:get": () => ({ ...mockSettings }),
    "settings:set": (patch: any) => Object.assign(mockSettings, patch),
    "settings:pickDownloadDir": () => "/Users/hong/Documents/UBION 받은파일",
    "files:save": (_c: string, _m: number, name: string, mode: string) => {
      const n = String(name).split(/[\\/]/).pop();
      if (mode === "saveAs" || mockSettings.askSaveLocation) return `/Users/hong/Desktop/${n}`;
      const dir = mockSettings.downloadDir || "/Users/hong/Downloads";
      const k = (mockSaved[n!] = (mockSaved[n!] ?? -1) + 1);
      return k ? `${dir}/${n!.replace(/(\.[^.]*)?$/, ` (${k})$1`)}` : `${dir}/${n}`;
    },
    "files:showInFolder": () => undefined,
    "auth:state": () => ({ user: new URLSearchParams(location.search).get("login") ? null : me, conn: "online" }),
    "rooms:list": () => rooms,
    "msg:history": (_k: string, before?: number) => (before ? [] : msgs),
    "org:presence": () => ({ 2: "online", 3: "away", 4: "online", 5: "offline", 6: "busy" }),
    "org:users": () => users,
    "org:departments": () => [{ id: 19, name: "UBION", sortOrder: 0, depth: 0 }, { id: 20, name: "개발팀", sortOrder: 1, depth: 1, parentId: 19 }, { id: 21, name: "디자인팀", sortOrder: 2, depth: 1, parentId: 19 }],
    "app:info": () => ({ version: "1.0.0", platform: "darwin", encryption: true }),
  };
  const isoNow = new Date().toISOString();
  const portalSnap = {
    summary: { chips: [{ appName: "mail", gadgetName: "메일", count: 2 }, { appName: "approval", gadgetName: "결재", count: 1 }, { appName: "calendar", gadgetName: "일정", count: 1 }] },
    badge: { approval: 1, noti: 3, mail: 2 },
    widgets: {
      posts: { id: "posts", updatedAt: Date.now(), data: { total: 2, items: [
        { id: 2, boardId: 7, boardName: "공지사항", type: "CLASSIC", summary: "11월 전사 워크숍 안내", createdAt: isoNow, writerName: "관리자", commentsCount: 2, recommendCount: 0, hasAttach: true, url: "/app/board/7/post/2" },
        { id: 1, boardId: 7, boardName: "공지사항", type: "CLASSIC", summary: "보안 점검 일정", createdAt: isoNow, writerName: "관리자", commentsCount: 0, recommendCount: 0, hasAttach: false, url: "/app/board/7/post/1" }] } },
      approvalTodo: { id: "approvalTodo", data: { total: 1, items: [{ id: 11, formName: "지출결의서", title: "10월 법인카드 정산", url: "/app/approval/document/11" }] } },
      approvalUpcoming: { id: "approvalUpcoming", data: { total: 0, items: [] } },
      noti: { id: "noti", data: { total: 3, items: [{ id: 5, category: "approval", senderName: "홍길동", message: "결재 요청이 도착했습니다", createdAt: isoNow, url: "/link/noti/5" }] } },
      mail: { id: "mail", data: { total: 2, today: 2, items: [{ id: "101", folderName: "받은편지함", folderFullName: "Inbox", subject: "주간 회의록", from: "김철수", seen: false, url: "/app/mail?work=read&folder=Inbox&uid=101" }] } },
    },
  };
  const bridge: Bridge = {
    async call(ch, ...args) {
      if (ch === "link:preview") return { url: args[0], title: "팀 위키 — 요구사항 정리", description: "1.0.10 파일 카드/링크 미리보기 요구사항과 일정", siteName: "example.com", image: "https://example.com/og.png" };
      if (ch === "link:image") return svg("#1f9d55", "OG");
      return handlers[ch]?.(...args);
    },
    onEvent: () => () => undefined,
    onOpenRoom: (cb) => {
      const r = new URLSearchParams(location.search).get("room");
      if (r) setTimeout(() => cb(r), 50);
      return () => undefined;
    },
    onOpenSettings: () => () => undefined,
    onFocus: () => () => undefined,
    onBadge: () => () => undefined,
    onUpdate: () => () => undefined,
    portal: {
      get: async () => portalSnap,
      refresh: async () => portalSnap,
      menu: async () => {
        const { STATIC_MENU, LOCAL_MENU } = await import("../electron/core/portal");
        return { items: [...STATIC_MENU, { id: "m70", name: "법인공용차량", appName: "custom", url: "/app/asset/30/list/reservation", section: "예약현황", custom: true, target: "portal" as const }, { id: "m58", name: "사이버연수원", appName: "link", url: "http://hrd.ubion.co.kr/", section: "링크", custom: true, target: "external" as const }, ...LOCAL_MENU], source: "static" as const };
      },
      open: async () => undefined,
      setActive: async () => undefined,
      mailFolders: async () => ({
        quota: { usageUnit: "1.2 GB", limitUnit: "10 GB", percent: 12 },
        defaultFolders: [
          { id: "1", name: "받은편지함", fullName: "Inbox", encName: "Inbox", depth: 0, newCnt: 2, unseenCnt: 2, totalCnt: 120 },
          { id: "2", name: "보낸편지함", fullName: "Sent", encName: "Sent", depth: 0, newCnt: 0, unseenCnt: 0, totalCnt: 88 },
        ],
        userFolders: [{ id: "3", name: "업무", fullName: "Inbox/업무", encName: "Inbox%2F%EC%97%85%EB%AC%B4", depth: 1, newCnt: 0, unseenCnt: 1, totalCnt: 7 }],
        userSharedFolders: [], userTags: [],
      }),
      mailList: async (folder: string, page: number, keyword = "") => {
        const people = [["김하늘", "sky.kim@example.com"], ["이서준", "seojun@example.com"], ["박지민", "jimin.park@example.org"], ["최유나", "yuna@example.net"], ["정민호", "minho@example.com"]];
        const subjects = ["4분기 로드맵 리뷰 일정 안내", "[공지] 사내 보안 점검 협조 요청", "견적서 송부드립니다", "주간 회의록 (10/21)", "신규 입사자 온보딩 자료", "디자인 시안 v3 피드백", "출장 경비 정산 확인 부탁드립니다", "서버 점검 완료 보고"];
        const all = Array.from({ length: 46 }, (_, i) => {
          const [name, addr] = people[i % people.length];
          return {
            uid: 900 - i, folder, subject: subjects[i % subjects.length], from: { name, address: addr },
            preview: "안녕하세요, 요청하신 내용 정리해서 공유드립니다. 확인 후 회신 부탁드립니다.",
            dateUtc: new Date(Date.now() - i * 5.5 * 3600_000).toISOString(), seen: i > 3 && i !== 6, hasAttach: i % 3 === 2,
            flagged: i === 5, answered: false, important: i === 1 || i === 9, size: "24KB",
          };
        }).filter((m) => !keyword || m.subject.includes(keyword) || m.from.address.includes(keyword) || m.from.name.includes(keyword));
        const size = 20, items = all.slice((page - 1) * size, page * size);
        return { folder, folderName: folder === "Inbox" ? "받은편지함" : folder, items, page, pageSize: size, total: all.length, unread: 3, lastPage: page * size >= all.length, search: !!keyword };
      },
      mailRead: async (folder: string, uid: number) => ({
        uid, folder, subject: "견적서 송부드립니다", from: { name: "박지민", address: "jimin.park@example.org" },
        to: [{ name: "홍길동", address: "hong@example.com" }], cc: [{ name: "김하늘", address: "sky.kim@example.com" }],
        dateUtc: new Date(Date.now() - 3 * 3600_000).toISOString(), important: false, flagged: false,
        html: '<p>안녕하세요, 홍길동 매니저님.</p><p>요청하신 <b>클라우드 이전 프로젝트</b> 견적서를 첨부와 같이 송부드립니다.</p><table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>항목</th><th>금액</th></tr><tr><td>컨설팅</td><td>12,000,000원</td></tr><tr><td>마이그레이션</td><td>28,500,000원</td></tr></table><p><img src="https://images.example.com/banner.png" width="480" height="60" alt="banner"></p><p>자세한 내용은 <a href="https://example.com/quote">견적 상세 페이지</a>를 참고해 주세요.</p><script>alert(1)</script><p>감사합니다.<br>박지민 드림</p>',
        attachments: [{ part: "1", name: "견적서_2026Q4.pdf", size: 204800, sizeLabel: "200KB", type: "pdf" }, { part: "2", name: "일정표.xlsx", size: 51200, sizeLabel: "50KB", type: "xlsx" }],
      }),
      approvalList: async () => ({
        items: [{
          id: 11, documentId: 11, formName: "지출결의서", title: "10월 법인카드 정산", docStatusName: "진행중",
          apprStatusName: "결재대기", attachCount: 1, commentCount: 1, drafterName: "홍길동", drafterDeptName: "개발팀",
          drafterPositionName: "매니저", draftedAt: isoNow, emergency: false, currentActivityUsers: [], url: "/app/approval/document/11",
        }],
        page: { page: 0, offset: 20, total: 1, totalPage: 1, lastPage: true },
      }),
      approvalCounts: async () => ({ todo: 1, upcoming: 0 }),
      mailSend: async (d: any) => { await new Promise((r) => setTimeout(r, 300)); if (String(d?.subject).includes("실패")) throw new Error("수신자 주소를 확인해 주세요 (mock code 500)"); return { ok: true as const }; },
      approvalAction: async (kind: "approve" | "return", _id: number | string, comment = "") => {
        await new Promise((r) => setTimeout(r, 150));
        if (kind === "return" && !comment.trim()) throw new Error("반려 사유를 입력하세요");
        return { ok: true as const };
      },
      approvalDoc: async () => ({
        document: {
          id: 11, formName: "지출결의서", title: "10월 법인카드 정산", docStatusName: "진행중",
          bodyHtml: "<h3>정산 내역</h3><table><tr><th>항목</th><th>금액</th></tr><tr><td>교통비</td><td>32,000원</td></tr></table>",
          attaches: [{ id: "9", name: "영수증.pdf", extention: "pdf", size: 204800 }],
          drafterName: "홍길동", drafterDeptName: "개발팀", drafterPositionName: "매니저", draftedAt: isoNow,
        },
        apprFlow: { activityGroups: [{ name: "결재선", activities: [
          { type: "approval", name: "승인", userName: "김하늘", userPosition: "책임", deptName: "개발팀", status: "APPROVED", statusName: "승인", comment: "확인했습니다", completedAt: isoNow },
          { type: "approval", name: "승인", userName: "이서준", userPosition: "선임", deptName: "개발팀", status: "WAIT", statusName: "대기", comment: "" },
        ] }] },
        actionCheck: { isApprovalWaitingUser: true },
        comments: [{ id: "1", author: "김하늘", content: "확인했습니다", createdAt: isoNow }],
      }),
      flexPending: async () => ({ count: 3, at: Date.now() }),
    },
    pathForFile: () => "",
    platform: new URLSearchParams(location.search).get("platform") || "darwin",
  };
  (window as any).ubion = bridge;
}
