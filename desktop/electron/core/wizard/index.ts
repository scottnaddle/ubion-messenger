/**
 * Build wizard index from portal menu + Works applets + discovered forms (GET only).
 * Works = DaouOffice module at /app/works on the portal host (coco.ubion.co.kr), not a separate site.
 */
import type { MenuEntry } from "../portal";
import { STATIC_MENU, LOCAL_MENU } from "../portal";
import { aliasesFor } from "./synonyms";
import type { WizardItem } from "./types";

export type GetJson = (path: string) => Promise<any>;

const STATIC_DEEPS: WizardItem[] = [
  {
    id: "d-asset",
    title: "회의실/스튜디오 예약",
    subtitle: "자산·예약",
    url: "/app/asset",
    target: "portal",
    appName: "asset",
    source: "asset",
    aliases: aliasesFor("회의실/스튜디오 예약", "/app/asset", "asset"),
  },
  {
    id: "d-works",
    title: "Works (코코 워크스)",
    subtitle: "업무 앱",
    url: "/app/works",
    target: "portal",
    appName: "works",
    source: "works",
    aliases: aliasesFor("Works 워크스", "/app/works", "works"),
  },
  {
    id: "d-approval",
    title: "전자결재 작성",
    subtitle: "결재 양식 선택",
    url: "/app/approval",
    target: "portal",
    appName: "approval",
    local: "approval",
    source: "static",
    aliases: aliasesFor("전자결재", "/app/approval", "approval"),
  },
  {
    id: "d-car",
    title: "법인공용차량",
    subtitle: "예약현황",
    url: "/app/asset/30/list/reservation",
    target: "portal",
    appName: "asset",
    source: "asset",
    aliases: aliasesFor("법인공용차량", "/app/asset/30/list/reservation", "asset"),
  },
  {
    id: "d-flex",
    title: "flex 휴가·근무",
    subtitle: "근태",
    url: "https://flex.team/home/todo/inbox",
    target: "portal",
    appName: "flex",
    source: "static",
    aliases: aliasesFor("flex 휴가", "https://flex.team", "flex"),
  },
];

function fromMenu(m: MenuEntry): WizardItem {
  return {
    id: `menu:${m.id}`,
    title: m.name,
    subtitle: m.section || m.appName,
    url: m.url,
    target: m.target,
    local: m.local,
    appName: m.appName,
    section: m.section,
    source: m.appName === "works" ? "works" : "menu",
    aliases: aliasesFor(m.name, m.url, m.appName),
  };
}

function asList(body: any): any[] {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.data?.list)) return body.data.list;
  if (Array.isArray(body?.data?.content)) return body.data.content;
  if (Array.isArray(body?.data?.applets)) return body.data.applets;
  if (Array.isArray(body?.applets)) return body.applets;
  if (Array.isArray(body?.list)) return body.list;
  return [];
}

/** Portal-session Works applet list (GET only). OpenAPI public/v1 is not used (needs separate OAuth). */
export async function discoverWorks(get: GetJson): Promise<WizardItem[]> {
  const out: WizardItem[] = [];
  const paths = [
    "/api/works/applets",
    "/api/works/applet",
    "/api/works/apps",
    "/api/works/app",
    "/api/works/my/applets",
    "/api/works/user/applets",
    "/api/go/applets",
    "/api/works",
  ];
  for (const path of paths) {
    try {
      const body = await get(path);
      const list = asList(body);
      if (!list.length) continue;
      for (const a of list.slice(0, 120)) {
        const id = a.appletId ?? a.id ?? a.appId ?? a.worksId;
        const name = String(a.name || a.title || a.appletName || a.appName || "").trim();
        if (!name || id == null) continue;
        // Common portal deep links for a Works applet
        const url = `/app/works/${encodeURIComponent(String(id))}`;
        out.push({
          id: `works:${id}`,
          title: name,
          subtitle: a.desc ? String(a.desc).slice(0, 80) : "Works 앱",
          url,
          target: "portal",
          appName: "works",
          source: "works",
          aliases: [
            ...aliasesFor(name, url, "works"),
            "Works",
            "워크스",
            "코코 워크스",
          ],
        });
      }
      if (out.length) break;
    } catch {
      /* try next */
    }
  }
  return out;
}

export async function discoverForms(get: GetJson): Promise<WizardItem[]> {
  const out: WizardItem[] = [];
  const candidates = [
    "/api/approval/form",
    "/api/approval/forms",
    "/api/approval/form/list",
    "/api/approval/docform",
    "/api/approval/document/form",
  ];
  for (const path of candidates) {
    try {
      const body = await get(path);
      const list = asList(body);
      if (!list.length) continue;
      for (const f of list.slice(0, 80)) {
        const id = f.id ?? f.formId ?? f.formCode;
        const name = String(f.formName || f.name || f.title || "").trim();
        if (!name || id == null) continue;
        const url = `/app/approval/document/new/${encodeURIComponent(String(id))}`;
        out.push({
          id: `form:${id}`,
          title: name,
          subtitle: "전자결재 양식",
          url,
          target: "portal",
          appName: "approval",
          source: "form",
          aliases: aliasesFor(name, url, "approval"),
        });
      }
      if (out.length) break;
    } catch {
      /* next */
    }
  }
  for (const path of ["/api/asset/resource", "/api/asset/resources", "/api/asset/place"]) {
    try {
      const body = await get(path);
      const list = asList(body);
      if (!list.length) continue;
      for (const r of list.slice(0, 40)) {
        const id = r.id ?? r.resourceId;
        const name = String(r.name || r.resourceName || r.title || "").trim();
        if (!name || id == null) continue;
        out.push({
          id: `asset:${id}`,
          title: name,
          subtitle: "예약 자원",
          url: `/app/asset`,
          target: "portal",
          appName: "asset",
          source: "asset",
          aliases: aliasesFor(name, "/app/asset", "asset"),
        });
      }
      break;
    } catch {
      /* next */
    }
  }
  return out;
}

export function buildIndexFromMenu(menuItems: MenuEntry[]): WizardItem[] {
  const items = [...menuItems, ...LOCAL_MENU.filter((m) => !menuItems.some((x) => x.name === m.name && x.appName === m.appName))];
  const mapped = items.map(fromMenu);
  const urls = new Set(mapped.map((m) => m.url));
  const names = new Set(mapped.map((m) => m.title));
  for (const d of STATIC_DEEPS) {
    if (!urls.has(d.url) && !names.has(d.title)) mapped.push(d);
  }
  for (const s of STATIC_MENU) {
    if (!mapped.some((m) => m.appName === s.appName)) mapped.push(fromMenu(s));
  }
  return mapped;
}

export async function buildWizardIndex(menuItems: MenuEntry[], get: GetJson): Promise<WizardItem[]> {
  const base = buildIndexFromMenu(menuItems);
  const [forms, works] = await Promise.all([discoverForms(get), discoverWorks(get)]);
  const byId = new Map<string, WizardItem>();
  for (const it of [...base, ...forms, ...works]) byId.set(it.id, it);
  return [...byId.values()];
}
