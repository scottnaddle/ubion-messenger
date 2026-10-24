/**
 * 내 봇 connector registry. Company tools run in the desktop against the logged-in
 * DaouOffice session. Google connectors become ready when a secure link is connected
 * (or when tests store oauthToken on prefs). Real refresh tokens are not stored here.
 * Nothing here talks to MiniMax.
 */

export type ConnectorAvailability = "session" | "connect-later";
export type ConnectorState = "ready" | "off" | "connect-later";
export type ToolEffect = "read" | "write";

export type ToolSchema = {
  name: string;
  description: string;
  effect: ToolEffect;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
};

export type ConnectorDef = {
  id: string;
  label: string;
  kind: "ubion" | "google" | "mcp";
  availability: ConnectorAvailability;
  tools: ToolSchema[];
};

export type ConnectorPrefs = Record<string, { enabled?: boolean; oauthToken?: string }>;

/** True when that connector's token lives in the desktop safe store, not in prefs. */
export type ConnectorLinkMap = Readonly<Record<string, boolean>>;

export type ResolvedConnector = ConnectorDef & { state: ConnectorState };

export const CONNECTOR_STORAGE_PREFIX = "ubm.personal-bot.connectors.v1:";

const READ_LIMIT = { type: "number", description: "최대 8건" };

export const CONNECTORS: readonly ConnectorDef[] = [
  {
    id: "ubion-mail",
    label: "회사 메일",
    kind: "ubion",
    availability: "session",
    tools: [
      {
        name: "ubion_mail_list",
        description: "로그인한 유비온 메일함의 최근 메일을 읽습니다. 메일을 열거나 보내지 않습니다.",
        effect: "read",
        parameters: {
          type: "object",
          properties: {
            folder: { type: "string", description: "폴더 이름. 기본값 Inbox" },
            keyword: { type: "string", description: "제목/본문 검색어" },
            limit: READ_LIMIT,
          },
        },
      },
      {
        name: "ubion_mail_send",
        description: "메일을 보냅니다. 1.1.3에서는 실행되지 않습니다.",
        effect: "write",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string" },
            subject: { type: "string" },
            body: { type: "string" },
          },
          required: ["to", "subject", "body"],
        },
      },
    ],
  },
  {
    id: "ubion-approval",
    label: "결재 대기",
    kind: "ubion",
    availability: "session",
    tools: [{
      name: "ubion_approval_list",
      description: "로그인한 사용자의 결재 대기 또는 예정 문서를 읽습니다. 승인하거나 반려하지 않습니다.",
      effect: "read",
      parameters: {
        type: "object",
        properties: {
          box: { type: "string", enum: ["todo", "upcoming"], description: "todo=결재 대기, upcoming=결재 예정" },
          limit: READ_LIMIT,
        },
      },
    }],
  },
  {
    id: "ubion-calendar",
    label: "오늘 일정",
    kind: "ubion",
    availability: "session",
    tools: [{
      name: "ubion_calendar_today",
      description: "로그인한 사용자의 오늘 유비온 일정을 읽습니다. 일정을 만들거나 지우지 않습니다.",
      effect: "read",
      parameters: { type: "object", properties: {} },
    }],
  },
  {
    id: "google-drive",
    label: "Google Drive",
    kind: "google",
    availability: "connect-later",
    tools: [{
      name: "google_drive_list",
      description: "연결한 Google Drive에서 문서를 찾습니다. 만들거나 수정·삭제·이동·공유하지 않습니다. query로 이름·검색어, mime으로 형식, folderId로 폴더를 좁히세요. 이어서 google_drive_read로 본문을 읽고 한국어로 정리·요약하세요.",
      effect: "read",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "파일 이름 또는 내용 검색어" },
          mime: { type: "string", description: "pdf, document, spreadsheet, presentation, docx, xlsx, pptx, text, csv, html" },
          folderId: { type: "string", description: "이 폴더 안에서만 찾습니다" },
          limit: READ_LIMIT,
        },
      },
    }, {
      name: "google_drive_read",
      description: "연결한 Drive 파일 본문을 읽습니다. 수정·삭제하지 않습니다. Google 문서·시트·슬라이드, PDF, 텍스트, docx, xlsx, pptx를 읽을 수 있습니다. 받은 텍스트만으로 한국어 요약을 하세요.",
      effect: "read",
      parameters: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "google_drive_list가 돌려준 파일 ID" },
          maxChars: { type: "number", description: "본문 최대 글자 수. 기본 12000, 최대 20000" },
        },
        required: ["fileId"],
      },
    }],
  },
  {
    id: "google-calendar",
    label: "Google Calendar",
    kind: "google",
    availability: "connect-later",
    tools: [{
      name: "google_calendar_today",
      description: "연결한 Google Calendar의 오늘 일정을 읽습니다.",
      effect: "read",
      parameters: { type: "object", properties: {} },
    }],
  },
];

export function connectorStorageKey(userId: number): string | null {
  if (!Number.isSafeInteger(userId)) return null;
  return `${CONNECTOR_STORAGE_PREFIX}${userId}`;
}

export function normalizeConnectorPrefs(data: unknown): ConnectorPrefs {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const prefs: ConnectorPrefs = {};
  for (const [id, value] of Object.entries(data)) {
    if (!value || typeof value !== "object") continue;
    const enabled = (value as { enabled?: unknown }).enabled;
    const oauthToken = (value as { oauthToken?: unknown }).oauthToken;
    prefs[id] = {
      ...(typeof enabled === "boolean" ? { enabled } : {}),
      ...(typeof oauthToken === "string" && oauthToken.trim() ? { oauthToken: oauthToken.trim() } : {}),
    };
  }
  return prefs;
}

type PrefsStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function loadConnectorPrefs(storage: Pick<PrefsStorage, "getItem">, userId: number): ConnectorPrefs {
  const key = connectorStorageKey(userId);
  if (!key) return {};
  try {
    const raw = storage.getItem(key);
    if (!raw) return {};
    return normalizeConnectorPrefs(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

export function saveConnectorPrefs(storage: Pick<PrefsStorage, "setItem">, userId: number, prefs: ConnectorPrefs): void {
  const key = connectorStorageKey(userId);
  if (!key) return;
  try {
    storage.setItem(key, JSON.stringify(prefs));
  } catch {
    /* best-effort */
  }
}

export function connectorState(
  def: ConnectorDef,
  pref: { enabled?: boolean; oauthToken?: string } | undefined,
  linked = false,
): ConnectorState {
  if (pref?.enabled === false) return "off";
  if (def.availability === "connect-later" && !pref?.oauthToken && !linked) return "connect-later";
  return "ready";
}

export function resolveConnectors(
  prefs: ConnectorPrefs = {},
  catalog: readonly ConnectorDef[] = CONNECTORS,
  links: ConnectorLinkMap = {},
): ResolvedConnector[] {
  return catalog.map((def) => ({ ...def, state: connectorState(def, prefs[def.id], links[def.id] === true) }));
}

/** Schemas the proxy may offer the model. Writes stay gated and are not advertised. */
export function advertisedTools(resolved: readonly ResolvedConnector[]): ToolSchema[] {
  return resolved
    .filter((c) => c.state === "ready")
    .flatMap((c) => c.tools.filter((tool) => tool.effect === "read"));
}

export function connectorStatusList(resolved: readonly ResolvedConnector[]): { id: string; label: string; state: ConnectorState }[] {
  return resolved.map((c) => ({ id: c.id, label: c.label, state: c.state }));
}

export function findTool(resolved: readonly ResolvedConnector[], name: string): { connector: ResolvedConnector; tool: ToolSchema } | null {
  for (const connector of resolved) {
    const tool = connector.tools.find((item) => item.name === name);
    if (tool) return { connector, tool };
  }
  return null;
}
