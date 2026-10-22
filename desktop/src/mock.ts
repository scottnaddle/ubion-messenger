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
      attach: { cryptId: "y", name: "요구사항정의서_v2.docx", size: 1832000 } },
    { messageId: 106, sendUserSeq: 1, sendUserName: "홍길동", message: "요구사항 문서 최신본입니다. 오후 회의 때 같이 봐요. https://example.com/wiki", createdAt: iso(11), userImage: "", needConfirmCount: 1 },
    { messageId: 107, sendUserSeq: 2, sendUserName: "김하늘", message: "네, 오후 3시에 회의실에서 봬요!", createdAt: iso(2), userImage: "" },
  ];
  const users = [2, 3, 4, 5, 6, 7].map((id, i) => ({
    userId: id, name: ["김하늘", "이서준", "박지우", "최유나", "정도윤", "한소희"][i], position: ["책임", "선임", "수석", "주임", "책임", "선임"][i],
    email: `user${id}@example.com`, thumbnail: "", departmentIds: [i % 2 ? 20 : 21],
  }));
  const handlers: Record<string, (...a: any[]) => any> = {
    "settings:get": () => ({ serverUrl: "https://coco.ubion.co.kr", username: "hong", rememberMe: true, autoLogin: true, theme: new URLSearchParams(location.search).get("theme") || "light", notifications: true, notificationPreview: true, notificationSound: true, launchAtLogin: false, closeToTray: true, downloadDir: "", fontSize: 14, autoUpdate: true, hasSavedPassword: true }),
    "auth:state": () => ({ user: new URLSearchParams(location.search).get("login") ? null : me, conn: "online" }),
    "rooms:list": () => rooms,
    "msg:history": (_k: string, before?: number) => (before ? [] : msgs),
    "org:presence": () => ({ 2: "online", 3: "away", 4: "online", 5: "offline", 6: "busy" }),
    "org:users": () => users,
    "org:departments": () => [{ id: 19, name: "UBION", sortOrder: 0, depth: 0 }, { id: 20, name: "개발팀", sortOrder: 1, depth: 1, parentId: 19 }, { id: 21, name: "디자인팀", sortOrder: 2, depth: 1, parentId: 19 }],
    "app:info": () => ({ version: "1.0.0", platform: "darwin", encryption: true }),
  };
  const bridge: Bridge = {
    async call(ch, ...args) {
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
    pathForFile: () => "",
    platform: new URLSearchParams(location.search).get("platform") || "darwin",
  };
  (window as any).ubion = bridge;
}
