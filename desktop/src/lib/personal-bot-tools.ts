/**
 * Executes 내 봇 tools inside the desktop. Company reads use the messenger session.
 * The MiniMax proxy never receives Daou cookies or passwords.
 */
import {
  findTool,
  type ResolvedConnector,
} from "./connectors";
import type { PersonalBotToolCall } from "./personal-bot";

export type UbionToolApi = {
  mailList(folder: string, page: number, keyword?: string): Promise<{
    folder: string;
    total: number;
    unread: number;
    items: { uid: number; subject: string; from: { name: string; address: string }; dateUtc?: string; seen: boolean; preview: string }[];
  }>;
  approvalList(box: "todo" | "upcoming", page: number): Promise<{
    items: { id: number; title: string; drafterName: string; draftedAt?: string; docStatusName?: string; emergency: boolean }[];
  }>;
  calendarToday(): Promise<{
    items: { summary: string; start: string; end: string; allDay: boolean; location: string }[];
  }>;
};

export type ToolExecContext = {
  resolved: readonly ResolvedConnector[];
  ubion?: UbionToolApi | null;
  /** Plug an MCP/OAuth executor by tool name without changing the chat loop. */
  extra?: Readonly<Record<string, (args: Record<string, unknown>) => Promise<unknown>>>;
};

const RESULT_LIMIT = 6000;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function limitOf(args: Record<string, unknown>): number {
  const n = Number(args.limit);
  if (!Number.isFinite(n)) return 8;
  return Math.max(1, Math.min(8, Math.floor(n)));
}

function pack(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > RESULT_LIMIT ? JSON.stringify({ ok: false, code: "truncated", message: "결과가 너무 길어 잘렸습니다." }) : text;
}

function fail(code: string, message: string): string {
  return pack({ ok: false, code, message });
}

export function ubionFromBridge(bridge: { portal?: { mailList: UbionToolApi["mailList"]; approvalList: (box: "todo" | "upcoming" | "draft" | "approve", page: number, keyword?: string) => Promise<Awaited<ReturnType<UbionToolApi["approvalList"]>>>; calendarToday: UbionToolApi["calendarToday"] } } | null | undefined): UbionToolApi | null {
  const portal = bridge?.portal;
  if (!portal?.mailList || !portal.approvalList || !portal.calendarToday) return null;
  return {
    mailList: (folder, page, keyword) => portal.mailList(folder, page, keyword),
    approvalList: (box, page) => portal.approvalList(box, page),
    calendarToday: () => portal.calendarToday(),
  };
}

async function runUbion(name: string, args: Record<string, unknown>, ubion: UbionToolApi): Promise<unknown> {
  if (name === "ubion_mail_list") {
    const folder = typeof args.folder === "string" && args.folder.trim() ? args.folder.trim().slice(0, 300) : "Inbox";
    const keyword = typeof args.keyword === "string" ? args.keyword.trim().slice(0, 100) : "";
    const page = await ubion.mailList(folder, 1, keyword);
    return {
      ok: true,
      folder: page.folder,
      total: page.total,
      unread: page.unread,
      items: page.items.slice(0, limitOf(args)).map((item) => ({
        uid: item.uid,
        subject: clip(item.subject, 120),
        from: item.from.name || item.from.address,
        dateUtc: item.dateUtc,
        seen: item.seen,
        preview: clip(item.preview, 80),
      })),
    };
  }
  if (name === "ubion_approval_list") {
    const box = args.box === "upcoming" ? "upcoming" : "todo";
    const page = await ubion.approvalList(box, 1);
    return {
      ok: true,
      box,
      items: page.items.slice(0, limitOf(args)).map((item) => ({
        id: item.id,
        title: clip(item.title, 140),
        drafter: item.drafterName,
        draftedAt: item.draftedAt,
        status: item.docStatusName,
        emergency: item.emergency,
      })),
    };
  }
  if (name === "ubion_calendar_today") {
    const page = await ubion.calendarToday();
    return {
      ok: true,
      items: page.items.slice(0, 12).map((item) => ({
        summary: clip(item.summary, 140),
        start: item.start,
        end: item.end,
        allDay: item.allDay,
        location: clip(item.location || "", 80),
      })),
    };
  }
  return { ok: false, code: "unknown", message: "이 도구는 데스크톱에 없습니다." };
}

/** One tool call. Always returns a JSON string the model can read. Does not throw for gated tools. */
export async function executePersonalBotTool(call: PersonalBotToolCall, ctx: ToolExecContext): Promise<string> {
  const found = findTool(ctx.resolved, call.name);
  if (!found) return fail("unknown", "알 수 없는 도구입니다.");
  if (found.connector.state === "off") return fail("off", `${found.connector.label} 연결이 꺼져 있습니다.`);
  if (found.connector.state === "connect-later") return fail("connect-later", `${found.connector.label}는 아직 연결 전입니다.`);
  if (found.tool.effect === "write") return fail("write-gated", "메일 보내기와 결재 처리 도구는 막혀 있습니다.");
  const extra = ctx.extra?.[call.name];
  try {
    if (extra) return pack(await extra(call.arguments));
    if (found.connector.kind === "ubion") {
      if (!ctx.ubion) return fail("session", "회사 세션을 찾지 못했습니다.");
      return pack(await runUbion(call.name, call.arguments, ctx.ubion));
    }
    return fail("not-plugged", `${found.connector.label} 실행기가 아직 연결되지 않았습니다.`);
  } catch {
    return fail("session", "회사 세션에서 가져오지 못했습니다.");
  }
}
