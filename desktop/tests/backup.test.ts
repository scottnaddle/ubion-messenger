import { afterEach, describe, expect, it, vi } from "vitest";
import { DaouClient, HttpError } from "../electron/core/daou-client";
import {
  BACKUP_DEFAULT_FILE_TYPE, backupDeletePath, backupDownloadPath, backupFileName, backupListPath, backupRequestPath,
  backupsForRoom, backupStatusLabel, buildBackupRequest, formatOffset, historyClearEnabled, historyClearPath,
  isBackupDone, normalizeBackupFileType, parseBackupList, shouldPollBackups,
} from "../electron/core/backup";
import { apiRoomSeq, checkForwardTarget } from "../electron/core/forward";

const reply = (text = "", status = 200, contentType = "application/json") =>
  new Response(text, { status, headers: { "content-type": contentType } });

function client() {
  const c = new DaouClient("https://daou.example");
  c.user = { id: 42, repId: 42, name: "나", loginId: "me", companyId: 1 };
  return c;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("backup paths", () => {
  it("builds the exact endpoints", () => {
    expect(backupRequestPath(7, 42)).toBe("/api/chat/7/backup?userSeq=42");
    expect(backupListPath(42)).toBe("/api/chat/backup/list?userSeq=42");
    expect(backupDownloadPath(7, 3, 42)).toBe("/api/chat/7/backup/3/download?userSeq=42");
    expect(backupDeletePath(7, 3, 42)).toBe("/api/chat/7/backup/3?userSeq=42");
    expect(historyClearPath(7, 99, 42)).toBe("/api/chat/7/99/before?userSeq=42");
  });

  it("rejects invalid ids", () => {
    expect(() => backupRequestPath(0, 42)).toThrow();
    expect(() => backupRequestPath("7/../x", 42)).toThrow();
    expect(() => backupDownloadPath(7, -1, 42)).toThrow();
    expect(() => backupDeletePath(7, 3, undefined)).toThrow();
    expect(() => historyClearPath(7, 0, 42)).toThrow();
    expect(() => backupListPath(1.5)).toThrow();
  });

  it("history clear path is distinct from markRead's /api/chat/rooms|buddies path", () => {
    expect(historyClearPath(7, 99, 42)).not.toMatch(/\/api\/chat\/(rooms|buddies|pubsubs)\//);
  });
});

describe("backup request body", () => {
  it("matches the original start/end-of-day format", () => {
    expect(buildBackupRequest("2026-10-01", "2026-10-23", "txt", 540)).toEqual({
      fromDate: "2026-10-01T00:00:00.000+09:00",
      toDate: "2026-10-23T23:59:59.999+09:00",
      fileType: "TXT",
    });
    expect(buildBackupRequest("2026-10-01", "2026-10-01", "HTML", -330).fromDate).toBe("2026-10-01T00:00:00.000-05:30");
    expect(buildBackupRequest("2026-10-01", "2026-10-02", undefined, 0).fileType).toBe(BACKUP_DEFAULT_FILE_TYPE);
    expect(BACKUP_DEFAULT_FILE_TYPE).toBe("TXT");
  });

  it("validates dates and type", () => {
    expect(() => buildBackupRequest("", "2026-10-01")).toThrow("시작일");
    expect(() => buildBackupRequest("2026-02-30", "2026-03-01")).toThrow();
    expect(() => buildBackupRequest("2026-10-05", "2026-10-01")).toThrow("늦습니다");
    expect(() => buildBackupRequest("2024-01-01", "2026-01-01")).toThrow("최대");
    expect(() => normalizeBackupFileType("pdf")).toThrow();
    expect(normalizeBackupFileType(" html ")).toBe("HTML");
  });

  it("formats offsets like moment's Z", () => {
    expect(formatOffset(540)).toBe("+09:00");
    expect(formatOffset(0)).toBe("+00:00");
    expect(formatOffset(-90)).toBe("-01:30");
  });
});

describe("backup list parsing", () => {
  const raw = {
    code: "200",
    data: [
      { id: 3, roomSeq: 7, status: "DONE", file: { name: "대화_백업.txt", size: 12 }, fileType: "TXT" },
      { id: "4", roomSeq: "8", status: "progress" },
      { id: 3, roomSeq: 7, status: "DONE" },
      { id: 0, roomSeq: 7 },
      { roomSeq: 7 },
      null,
      "junk",
    ],
  };

  it("is defensive about shape", () => {
    const list = parseBackupList(raw);
    expect(list).toEqual([
      expect.objectContaining({ id: 3, roomSeq: 7, status: "DONE", fileName: "대화_백업.txt", size: 12, fileType: "TXT" }),
      expect.objectContaining({ id: 4, roomSeq: 8, status: "PROGRESS", fileName: "" }),
    ]);
    expect(parseBackupList(raw.data)).toHaveLength(2);
    expect(parseBackupList({ data: { list: raw.data } })).toHaveLength(2);
    expect(parseBackupList({ list: [{ backupId: 9, roomSeq: 1, backupFileName: "x.html" }] })[0]).toMatchObject({ id: 9, fileName: "x.html" });
    expect(parseBackupList(null)).toEqual([]);
    expect(parseBackupList({ data: "nope" })).toEqual([]);
    expect(parseBackupList("x")).toEqual([]);
  });

  it("filters, labels, names and decides polling", () => {
    const list = parseBackupList(raw);
    expect(backupsForRoom(list, 7).map((b) => b.id)).toEqual([3]);
    expect(isBackupDone(list[0])).toBe(true);
    expect(shouldPollBackups(list)).toBe(true);
    expect(shouldPollBackups([list[0]])).toBe(false);
    expect(shouldPollBackups([{ ...list[1], status: "FAIL" }])).toBe(false);
    expect(backupStatusLabel("DONE")).toBe("완료");
    expect(backupStatusLabel("PROGRESS")).toBe("백업 중");
    expect(backupStatusLabel("FAIL")).toBe("실패");
    expect(backupFileName(list[0])).toBe("대화_백업.txt");
    expect(backupFileName({ id: 4, roomSeq: 8, fileName: "", fileType: "HTML" })).toBe("chat_backup_8_4.html");
  });
});

describe("history clear flag", () => {
  it("is off unless UBM_HISTORY_CLEAR=1", () => {
    expect(historyClearEnabled({})).toBe(false);
    expect(historyClearEnabled(undefined)).toBe(false);
    expect(historyClearEnabled({ UBM_HISTORY_CLEAR: "true" })).toBe(false);
    expect(historyClearEnabled({ UBM_HISTORY_CLEAR: "1" })).toBe(true);
  });

  it("self-only guard refuses other rooms (same guard the IPC uses)", () => {
    const self = apiRoomSeq({ kind: "buddy", seq: 42, buddyRoomSeq: 500 });
    expect(() => checkForwardTarget({ selfOnly: true, target: { roomSeq: 7 }, me: 42, selfRoomSeq: self })).toThrow();
    expect(() => checkForwardTarget({ selfOnly: true, target: { roomSeq: 500 }, me: 42, selfRoomSeq: self })).not.toThrow();
  });
});

describe("DaouClient backup methods", () => {
  it("POSTs the JSON request", async () => {
    const fetchMock = vi.fn(async () => reply('{"code":"200"}'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(client().requestBackup(7, "2026-10-01", "2026-10-02", "html")).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://daou.example/api/chat/7/backup?userSeq=42");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(Buffer.from(init.body as Buffer).toString("utf8"));
    expect(body).toMatchObject({ fileType: "HTML" });
    expect(body.fromDate).toMatch(/^2026-10-01T00:00:00\.000[+-]\d\d:\d\d$/);
    expect(body.toDate).toMatch(/^2026-10-02T23:59:59\.999[+-]\d\d:\d\d$/);
  });

  it("does not call the server for an invalid range", async () => {
    const fetchMock = vi.fn(async () => reply("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(client().requestBackup(7, "2026-10-05", "2026-10-01")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists, downloads and deletes", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/chat/backup/list?userSeq=42")) return reply(JSON.stringify({ data: [{ id: 3, roomSeq: 7, status: "DONE" }] }));
      if (url.includes("/download")) return reply("hello", 200, "text/plain");
      if (init?.method === "DELETE") return reply('{"code":"200"}');
      return reply("", 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const c = client();
    expect(await c.listBackups()).toEqual([expect.objectContaining({ id: 3, roomSeq: 7, status: "DONE" })]);
    const d = await c.downloadBackup(7, 3);
    expect(d.data.toString("utf8")).toBe("hello");
    await expect(c.deleteBackup(7, 3)).resolves.toEqual({ ok: true });
    const del = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "DELETE")!;
    expect(del[0]).toBe("https://daou.example/api/chat/7/backup/3?userSeq=42");
  });

  it("surfaces HTTP and body-code failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply('{"code":"403","message":"권한 없음"}')));
    await expect(client().deleteBackup(7, 3)).rejects.toThrow("권한 없음");
    vi.stubGlobal("fetch", vi.fn(async () => reply("", 500)));
    await expect(client().requestBackup(7, "2026-10-01", "2026-10-01")).rejects.toBeInstanceOf(HttpError);
  });

  it("clearHistoryBefore PUTs the distinct path", async () => {
    const fetchMock = vi.fn(async () => reply(""));
    vi.stubGlobal("fetch", fetchMock);
    await client().clearHistoryBefore(7, 99);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://daou.example/api/chat/7/99/before?userSeq=42");
    expect(init.method).toBe("PUT");
    expect(init.body).toBeUndefined();
  });
});
