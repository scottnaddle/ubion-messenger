/**
 * Korean synonym / alias table for common company request & reservation keywords.
 * Maps search terms → needles matched against menu name/url/appName.
 */
export type SynonymRule = { needles: string[]; aliases: string[] };

/** Built-in alias expansions applied when indexing and when querying. */
export const SYNONYM_RULES: SynonymRule[] = [
  { needles: ["명함"], aliases: ["명함", "명함신청", "명함 신청", "business card"] },
  { needles: ["차량", "법인차", "법인 차량", "업무용차"], aliases: ["차량", "법인 차량", "법인차량", "업무용 차량", "배차", "차량 예약"] },
  { needles: ["회의실", "미팅룸", "회의실 예약"], aliases: ["회의실", "회의실/스튜디오", "스튜디오", "회의실 예약", "asset", "예약"] },
  { needles: ["휴가", "연차", "반차"], aliases: ["휴가", "연차", "근태", "ehr", "flex", "휴가·근무"] },
  { needles: ["결재", "전자결재", "품의"], aliases: ["전자결재", "결재", "approval", "품의"] },
  { needles: ["메일", "이메일"], aliases: ["메일", "mail", "이메일"] },
  { needles: ["캘린더", "일정", "스케줄"], aliases: ["캘린더", "calendar", "일정"] },
  { needles: ["게시판", "공지"], aliases: ["게시판", "board", "전사게시판", "공지"] },
  { needles: ["주소록", "연락처"], aliases: ["주소록", "contact", "연락처"] },
  { needles: ["설문"], aliases: ["설문", "survey"] },
  { needles: ["보고"], aliases: ["보고", "report"] },
  { needles: ["클라우드", "웹폴더", "파일"], aliases: ["클라우드", "webfolder", "웹폴더"] },
  { needles: ["예약", "대여"], aliases: ["예약", "대여", "asset", "회의실/스튜디오"] },
  { needles: ["워크스", "works", "쿠코", "코코 워크스"], aliases: ["Works", "워크스", "works", "코코 워크스"] },
  { needles: ["법인공용차량", "공용차량"], aliases: ["법인공용차량", "법인 차량", "공용차량", "차량 예약"] },
];

/** Extra aliases for a menu entry name/url based on synonym table. */
export function aliasesFor(name: string, url: string, appName: string): string[] {
  const blob = `${name} ${url} ${appName}`.toLowerCase();
  const out = new Set<string>();
  for (const rule of SYNONYM_RULES) {
    if (rule.needles.some((n) => blob.includes(n.toLowerCase()) || name.includes(n))) {
      for (const a of rule.aliases) out.add(a);
    }
  }
  return [...out];
}

/** Expand a user query with synonym needles (for multi-pass search). */
export function expandQuery(query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  const out = new Set<string>([q]);
  const nq = q.replace(/\s+/g, "").toLowerCase();
  for (const rule of SYNONYM_RULES) {
    if (rule.aliases.some((a) => a.replace(/\s+/g, "").toLowerCase() === nq || a.includes(q) || nq.includes(a.replace(/\s+/g, "").toLowerCase()))) {
      for (const a of rule.aliases) out.add(a);
      for (const n of rule.needles) out.add(n);
    }
  }
  return [...out];
}
