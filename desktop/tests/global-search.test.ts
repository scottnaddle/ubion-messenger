import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAttachesPath, buildRoomSearchPath, createRateLimiter, dayBound, formatSearchDate, globalSearchCaps, orderRoomsForSearch,
  parseAttachRows, runGlobalSearch, serverDates, serverPlan, type GlobalSearchDeps,
} from "../electron/core/global-search";
import { bigrams, LocalSearchIndex, normalizeText } from "../electron/core/search-index";
import { SearchCacheStore, type CacheFs } from "../electron/core/search-cache";
import { DaouClient } from "../electron/core/daou-client";
import { groupHitsByRoom, mergeHits, normalizeGlobalQuery, type GlobalSearchProgress, type SearchHit } from "../src/lib/global-search";
import type { ChatMessage, Room } from "../electron/core/types";

const room = (key: string, createdAt: string, extra: Partial<Room> = {}): Room => {
  const [kind, seq] = key.split(":");
  return {
    key, kind: kind as Room["kind"], seq: Number(seq), name: key, preview: "", unread: 0, createdAt,
    usePin: false, usePush: true, avatar: "", isSelf: false, ...extra,
  };
};

const msg = (messageId: number, message: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId, message, sendUserName: "김하늘", sendUserSeq: 2, userImage: "", createdAt: "2026-10-20T10:00:00.000+09:00", ...extra,
});

const hit = (messageId: number, source: SearchHit["source"], extra: Partial<SearchHit> = {}): SearchHit => ({
  roomKey: "room:1", messageId, sendUserName: "a", message: "m", createdAt: "2026-10-20T10:00:00.000Z", source, ...extra,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("global search: request params", () => {
  it("formats dates like moment YYYY-MM-DDTHH:mm:ss.SSSZ (local offset) and round-trips", () => {
    const d = dayBound("2026-10-24", false);
    const s = formatSearchDate(d);
    expect(s).toMatch(/^2026-10-24T00:00:00\.000[+-]\d{2}:\d{2}$/);
    expect(new Date(s).getTime()).toBe(d.getTime());
    expect(formatSearchDate(dayBound("2026-10-24", true))).toMatch(/^2026-10-24T23:59:59\.999[+-]\d{2}:\d{2}$/);
  });

  it("builds the official per-room search path in the official param order", () => {
    expect(buildRoomSearchPath({ roomSeq: 7, roomType: "room", userSeq: 42, keyword: "회의 자료" })).toBe(
      "/api/chat/7/search?offset=20&page=0&userSeq=42&keyword=%ED%9A%8C%EC%9D%98%20%EC%9E%90%EB%A3%8C&roomType=room"
    );
    // identical to the official encodeURI for normal text, but & stays inside the value
    expect(buildRoomSearchPath({ roomSeq: 7, roomType: "room", userSeq: 42, keyword: "견적서" })).toContain(`keyword=${encodeURI("견적서")}`);
    expect(buildRoomSearchPath({ roomSeq: 7, roomType: "single", userSeq: 42, keyword: "a&b" })).toContain("keyword=a%26b&roomType=single");
    const from = dayBound("2026-10-01", false);
    const to = dayBound("2026-10-01", true);
    const p = buildRoomSearchPath({ roomSeq: 3, roomType: "pubsub", userSeq: 42, page: 2, from, to, sendUserSeq: 9 })!;
    expect(p).toBe(
      `/api/chat/3/search?offset=20&page=2&userSeq=42&fromDate=${encodeURIComponent(formatSearchDate(from))}` +
        `&toDate=${encodeURIComponent(formatSearchDate(to))}&sendUserSeq=9&roomType=pubsub`
    );
  });

  it("skips the call when there is no keyword, date or sender (like the official client)", () => {
    expect(buildRoomSearchPath({ roomSeq: 7, roomType: "room", userSeq: 42, keyword: "  " })).toBeNull();
    expect(buildRoomSearchPath({ roomSeq: 7, roomType: "room", userSeq: 42, sendUserSeq: 5 })).toContain("sendUserSeq=5");
  });

  it("builds the attaches path per room kind", () => {
    expect(buildAttachesPath({ kind: "room", seq: 10, userSeq: 42, attachType: "file" })).toBe(
      "/api/chat/rooms/attaches/10?size=50&attachType=file&userSeq=42"
    );
    expect(buildAttachesPath({ kind: "buddy", seq: 2, userSeq: 42, attachType: "image", size: 6, criteriaMessageId: 99 })).toBe(
      "/api/chat/buddies/attaches/2?size=6&attachType=image&userSeq=42&criteriaMessageId=99"
    );
    expect(buildAttachesPath({ kind: "unknown", seq: 2, userSeq: 42, attachType: "file" })).toBeNull();
  });

  it("only sends a single-day date to the server unless UBM_SEARCH_DATE_RANGE=1", () => {
    expect(serverDates({ from: "2026-10-01", to: "2026-10-01" }, false)).not.toBeNull();
    expect(serverDates({ from: "2026-10-01", to: "2026-10-05" }, false)).toBeNull();
    expect(serverDates({ from: "2026-10-01", to: "2026-10-05" }, true)?.to.getDate()).toBe(5);
    expect(serverPlan({ from: "2026-10-01", to: "2026-10-05" }, false)).toBeNull(); // local only
    expect(serverPlan({ keyword: "x", from: "2026-10-01", to: "2026-10-05" }, false)).toEqual({ mode: "search", dates: null });
    expect(serverPlan({ files: "file" }, false)?.mode).toBe("files");
  });

  it("normalizes renderer queries", () => {
    expect(normalizeGlobalQuery({ keyword: "  회의   자료 ", to: "2026-10-03", senderSeq: "9", files: "file" })).toEqual({
      keyword: "회의 자료", from: "2026-10-03", to: "2026-10-03", senderSeq: 9, files: "file",
    });
    expect(normalizeGlobalQuery({ from: "2026-10-05", to: "2026-10-01" })).toEqual({ from: "2026-10-01", to: "2026-10-05" });
    expect(() => normalizeGlobalQuery({ keyword: " ", from: "bad", senderSeq: -1, files: "exe" })).toThrow();
    expect(normalizeGlobalQuery({ keyword: "x".repeat(500) }).keyword).toHaveLength(100);
  });

  it("caps: server fan-out on by default, date range + room cap via env", () => {
    expect(globalSearchCaps({})).toEqual({ server: true, dateRange: false, maxRooms: 60, localEngine: "inverted-index-json" });
    expect(globalSearchCaps({ UBM_GLOBAL_SEARCH_SERVER: "0", UBM_SEARCH_DATE_RANGE: "1", UBM_SEARCH_MAX_ROOMS: "9999" })).toMatchObject({
      server: false, dateRange: true, maxRooms: 500,
    });
  });

  it("client.searchGet only allows the read-only search/attaches endpoints", async () => {
    const c = new DaouClient("https://daou.example");
    c.user = { id: 42, repId: 42, name: "나", loginId: "me" };
    const fetchMock = vi.fn(async () => new Response('{"data":[]}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(c.searchGet("/api/chat/message/delete?userSeq=42")).rejects.toThrow();
    await expect(c.searchGet("/api/chat/rooms/10?size=1")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(c.searchGet("/api/chat/7/search?offset=20&page=0&userSeq=42&keyword=a&roomType=room")).resolves.toEqual({ data: [] });
    await expect(c.searchGet("/api/chat/rooms/attaches/10?size=50&attachType=file&userSeq=42")).resolves.toEqual({ data: [] });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    expect(calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
});

describe("global search: ordering + rate limit", () => {
  it("orders rooms by last message time (pins ignored), drops unsearchable rooms, caps the count", () => {
    const rooms = [
      room("room:1", "2026-10-01T00:00:00Z", { usePin: true }),
      room("buddy:2", "2026-10-20T00:00:00Z"),
      room("pubsub:3", "2026-10-10T00:00:00Z"),
      room("unknown:4", "2026-10-30T00:00:00Z"),
      room("room:5", "2026-10-15T00:00:00Z"),
    ];
    expect(orderRoomsForSearch(rooms, 10).map((r) => r.key)).toEqual(["buddy:2", "room:5", "pubsub:3", "room:1"]);
    expect(orderRoomsForSearch(rooms, 2).map((r) => r.key)).toEqual(["buddy:2", "room:5"]);
  });

  it("limits concurrency and spaces task starts", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const limiter = createRateLimiter({
      concurrency: 2,
      minIntervalMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    let active = 0;
    let peak = 0;
    const starts: number[] = [];
    const task = async () => {
      starts.push(clock);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
    };
    await Promise.all(Array.from({ length: 6 }, () => limiter.run(task)));
    expect(peak).toBeLessThanOrEqual(2);
    expect(starts).toHaveLength(6);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(100);
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("does not start queued tasks after abort", async () => {
    const ac = new AbortController();
    const limiter = createRateLimiter({ concurrency: 1, minIntervalMs: 0 });
    const ran: number[] = [];
    const p1 = limiter.run(async () => {
      ran.push(1);
      ac.abort();
    }, ac.signal);
    const p2 = limiter.run(async () => void ran.push(2), ac.signal);
    await p1;
    await expect(p2).rejects.toThrow();
    expect(ran).toEqual([1]);
  });
});

describe("global search: merge / dedupe", () => {
  it("dedupes by messageId, server wins over local, newest first", () => {
    const local = [hit(1, "local", { message: "old" }), hit(2, "local", { createdAt: "2026-10-21T00:00:00Z" })];
    const merged = mergeHits(local, [hit(1, "server", { message: "fresh" }), hit(3, "server", { createdAt: "2026-10-22T00:00:00Z" })]);
    expect(merged.map((h) => h.messageId)).toEqual([3, 2, 1]);
    expect(merged.find((h) => h.messageId === 1)).toMatchObject({ message: "fresh", source: "server" });
    // a later local hit never overrides a server hit
    expect(mergeHits(merged, [hit(1, "local", { message: "stale" })]).find((h) => h.messageId === 1)?.message).toBe("fresh");
  });

  it("groups hits by room, rooms ordered by newest hit", () => {
    const g = groupHitsByRoom([
      hit(1, "server", { roomKey: "room:1", createdAt: "2026-10-01T00:00:00Z" }),
      hit(2, "server", { roomKey: "buddy:2", createdAt: "2026-10-05T00:00:00Z" }),
      hit(3, "server", { roomKey: "room:1", createdAt: "2026-10-03T00:00:00Z" }),
    ]);
    expect(g.map((x) => [x.roomKey, x.hits.map((h) => h.messageId)])).toEqual([["buddy:2", [2]], ["room:1", [3, 1]]]);
  });
});

describe("global search: runner (fake server)", () => {
  const instantLimiter = createRateLimiter({ concurrency: 2, minIntervalMs: 0 });
  const deps = (over: Partial<GlobalSearchDeps>): GlobalSearchDeps => ({
    searchId: 1, rooms: [], userSeq: 42, getJson: async () => ({ data: [] }), limiter: instantLimiter,
    maxRooms: 60, serverEnabled: true, dateRangeEnabled: false, ...over,
  });

  it("searches local first, then rooms recent-first, streams partials and merges/dedupes", async () => {
    const index = new LocalSearchIndex();
    index.add("room:1", [msg(100, "예산 회의는 3시", { createdAt: "2026-10-01T00:00:00Z" })]);
    const paths: string[] = [];
    const rooms = [room("room:1", "2026-10-01T00:00:00Z"), room("buddy:2", "2026-10-20T00:00:00Z")];
    const getJson = vi.fn(async (p: string) => {
      paths.push(p);
      if (p.startsWith("/api/chat/1/")) return { data: [{ messageId: 100, message: "예산 회의는 3시", sendUserName: "김", createdAt: "2026-10-01T00:00:00Z" }] };
      return { data: [{ messageId: 200, message: "예산 회의 자료", sendUserName: "이", sendUserSeq: 3, createdAt: "2026-10-20T00:00:00Z" }] };
    });
    const progress: GlobalSearchProgress[] = [];
    const res = await runGlobalSearch({ keyword: "예산 회의" }, deps({ rooms, getJson, index, limiter: createRateLimiter({ concurrency: 1, minIntervalMs: 0 }), onProgress: (p) => progress.push(p) }));
    expect(progress[0]).toMatchObject({ phase: "local", hits: [expect.objectContaining({ messageId: 100, source: "local" })] });
    expect(paths[0]).toContain("/api/chat/2/search?"); // most recent room first
    expect(paths[0]).toContain("roomType=single");
    expect(paths[1]).toContain("/api/chat/1/search?");
    expect(progress.at(-1)).toMatchObject({ phase: "done", searchedRooms: 2, totalRooms: 2 });
    expect(res.hits.map((h) => [h.messageId, h.source])).toEqual([[200, "server"], [100, "server"]]);
    expect(index.has(200)).toBe(true); // server results are cached locally
  });

  it("caps rooms, counts failures without aborting, and filters multi-day dates client side", async () => {
    const rooms = Array.from({ length: 5 }, (_, i) => room(`room:${i + 1}`, `2026-10-0${i + 1}T00:00:00Z`));
    const getJson = vi.fn(async (p: string) => {
      if (p.startsWith("/api/chat/5/")) throw new Error("boom");
      return { data: [
        { messageId: Number(p.split("/")[3]) * 10, message: "x", createdAt: "2026-10-03T12:00:00+09:00" },
        { messageId: Number(p.split("/")[3]) * 10 + 1, message: "x", createdAt: "2026-09-01T12:00:00+09:00" },
      ] };
    });
    const onRoomError = vi.fn();
    const res = await runGlobalSearch(
      { keyword: "x", from: "2026-10-02", to: "2026-10-04" },
      deps({ rooms, getJson, maxRooms: 3, onRoomError })
    );
    expect(getJson).toHaveBeenCalledTimes(3);
    expect(getJson.mock.calls.every(([p]) => !p.includes("fromDate"))).toBe(true); // multi-day not sent (flag off)
    expect(res).toMatchObject({ searchedRooms: 3, totalRooms: 3, failedRooms: 1 });
    expect(onRoomError).toHaveBeenCalledTimes(1);
    expect(res.hits.map((h) => h.messageId).sort()).toEqual([30, 40]);
  });

  it("file filter uses the attaches API and matches the keyword against file names", async () => {
    const getJson = vi.fn(async () => ({ data: [
      { messageId: 1, sendUserSeq: 2, sendUserName: "김", createdAt: "2026-10-20T00:00:00Z", chatMessageAttachFileModel: { itemId: "c1", fileName: "견적서_v2.pdf", fileSize: 1200 } },
      { messageId: 2, sendUserSeq: 2, sendUserName: "김", createdAt: "2026-10-20T00:00:00Z", chatMessageAttachFileModel: { itemId: "c2", fileName: "회의록.docx" } },
    ] }));
    const res = await runGlobalSearch({ keyword: "견적", files: "file" }, deps({ rooms: [room("room:10", "2026-10-20T00:00:00Z")], getJson }));
    expect(getJson).toHaveBeenCalledWith("/api/chat/rooms/attaches/10?size=50&attachType=file&userSeq=42");
    expect(res.hits).toEqual([expect.objectContaining({ messageId: 1, attach: expect.objectContaining({ name: "견적서_v2.pdf", cryptId: "c1", size: 1200 }) })]);
  });

  it("skips the server when disabled or when filters can't be sent, and stops on cancel", async () => {
    const getJson = vi.fn(async () => ({ data: [] }));
    const rooms = [room("room:1", "2026-10-01T00:00:00Z"), room("room:2", "2026-10-02T00:00:00Z"), room("room:3", "2026-10-03T00:00:00Z")];
    expect((await runGlobalSearch({ keyword: "a" }, deps({ rooms, getJson, serverEnabled: false }))).serverSearched).toBe(false);
    expect((await runGlobalSearch({ from: "2026-10-01", to: "2026-10-03" }, deps({ rooms, getJson }))).serverSearched).toBe(false);
    expect(getJson).not.toHaveBeenCalled();

    const ac = new AbortController();
    const cancelling = vi.fn(async () => {
      ac.abort();
      return { data: [] };
    });
    const res = await runGlobalSearch({ keyword: "a" }, deps({ rooms, getJson: cancelling, signal: ac.signal, limiter: createRateLimiter({ concurrency: 1, minIntervalMs: 0 }) }));
    expect(cancelling).toHaveBeenCalledTimes(1);
    expect(res.cancelled).toBe(true);
  });

  it("parses attach rows (itemId/fileName/fileSize) and ignores rows without a file", () => {
    const list = parseAttachRows({ data: [{ messageId: 5, chatMessageAttachFileModel: { itemId: "z", fileName: "a.png", filePhotoPath: "/p" } }, { messageId: 6 }] }, "room:1");
    expect(list).toHaveLength(1);
    expect(list[0].attach).toMatchObject({ cryptId: "z", name: "a.png", imageFile: true });
  });
});

describe("local search index", () => {
  it("bigram tokenizes Korean text and matches substrings case-insensitively", () => {
    expect(bigrams("회의 자료")).toEqual(["회의", "의자", "자료"]);
    expect(normalizeText("  Hello\n World ")).toBe("hello world");
    const idx = new LocalSearchIndex();
    idx.add("room:1", [msg(1, "내일 예산회의 자료 공유드립니다"), msg(2, "Deploy DONE"), msg(3, "점심 메뉴")]);
    expect(idx.search({ keyword: "예산회의" }).map((d) => d.messageId)).toEqual([1]);
    expect(idx.search({ keyword: "회의 자료" }).map((d) => d.messageId)).toEqual([1]); // substring incl. space
    expect(idx.search({ keyword: "deploy" }).map((d) => d.messageId)).toEqual([2]);
    expect(idx.search({ keyword: "점" }).map((d) => d.messageId)).toEqual([3]); // 1-char → scan
    expect(idx.search({ keyword: "회의자료" })).toEqual([]); // bigrams present but not a substring
  });

  it("applies sender/date/room/file filters and file-name matching", () => {
    const idx = new LocalSearchIndex();
    idx.add("room:1", [
      msg(1, "보고서", { sendUserSeq: 2, createdAt: "2026-10-01T10:00:00Z" }),
      msg(2, "보고서", { sendUserSeq: 3, createdAt: "2026-10-05T10:00:00Z" }),
      msg(3, "", { attach: { cryptId: "c", name: "보고서_최종.pdf" }, createdAt: "2026-10-06T10:00:00Z" }),
    ]);
    idx.add("buddy:9", [msg(4, "보고서", { createdAt: "2026-10-07T10:00:00Z" })]);
    expect(idx.search({ keyword: "보고서", senderSeq: 3 }).map((d) => d.messageId)).toEqual([2]);
    expect(idx.search({ keyword: "보고서", fromMs: Date.parse("2026-10-04T00:00:00Z"), toMs: Date.parse("2026-10-06T23:00:00Z") }).map((d) => d.messageId)).toEqual([3, 2]);
    expect(idx.search({ keyword: "최종", files: "file" }).map((d) => d.messageId)).toEqual([3]);
    expect(idx.search({ files: "file" }).map((d) => d.messageId)).toEqual([3]);
    expect(idx.search({ keyword: "보고서", roomKeys: ["buddy:9"] }).map((d) => d.messageId)).toEqual([4]);
  });

  it("updates edited text, drops deleted messages, ignores pending ones, evicts oldest", () => {
    const idx = new LocalSearchIndex(2);
    idx.add("room:1", [msg(1, "첫번째", { createdAt: "2026-10-01T00:00:00Z" }), msg(2, "두번째", { createdAt: "2026-10-02T00:00:00Z" })]);
    idx.add("room:1", [msg(2, "바뀐내용", { createdAt: "2026-10-02T00:00:00Z" })]);
    expect(idx.search({ keyword: "두번째" })).toEqual([]);
    expect(idx.search({ keyword: "바뀐" })).toHaveLength(1);
    idx.add("room:1", [msg(9, "임시", { pending: true })]);
    expect(idx.has(9)).toBe(false);
    idx.add("room:1", [msg(3, "세번째", { createdAt: "2026-10-03T00:00:00Z" })]);
    expect(idx.size).toBe(2);
    expect(idx.has(1)).toBe(false);
    idx.add("room:1", [msg(3, "", { deleted: true })]);
    expect(idx.has(3)).toBe(false);
  });

  it("round-trips through JSON and treats corrupt files as empty", () => {
    const idx = new LocalSearchIndex();
    idx.add("room:1", [msg(1, "안녕하세요 반갑습니다")]);
    const re = LocalSearchIndex.fromJSON(idx.toJSON());
    expect(re.search({ keyword: "반갑" }).map((d) => d.messageId)).toEqual([1]);
    expect(re.isDirty).toBe(false);
    expect(LocalSearchIndex.fromJSON("{oops").size).toBe(0);
    expect(LocalSearchIndex.fromJSON(JSON.stringify({ v: 999, docs: [{}] })).size).toBe(0);
  });
});

describe("search cache store (fake fs, client-local)", () => {
  const fakeFs = () => {
    const files = new Map<string, string>();
    const fs: CacheFs & { files: Map<string, string> } = {
      files,
      readFileSync: (p) => {
        if (!files.has(p)) throw new Error("ENOENT");
        return files.get(p)!;
      },
      writeFileSync: (p, d) => void files.set(p, d),
      renameSync: (a, b) => {
        files.set(b, files.get(a)!);
        files.delete(a);
      },
      mkdirSync: () => undefined,
      rmSync: (p) => {
        for (const k of [...files.keys()]) if (k.startsWith(p)) files.delete(k);
      },
    };
    return fs;
  };

  it("persists per user under userData, reloads, and clears", () => {
    const fs = fakeFs();
    const store = new SearchCacheStore("/ud/search-cache", fs);
    expect(store.for(undefined)).toBeNull();
    store.for(42)!.add("room:1", [msg(1, "비밀 아닌 메시지")]);
    store.flush();
    expect([...fs.files.keys()]).toEqual(["/ud/search-cache/42.json"]);
    // other account gets its own (empty) index; switching flushes nothing new
    expect(store.for(7)!.size).toBe(0);
    const again = new SearchCacheStore("/ud/search-cache", fs);
    expect(again.for(42)!.search({ keyword: "메시지" })).toHaveLength(1);
    again.clear();
    expect(fs.files.size).toBe(0);
    expect(again.for(42)!.size).toBe(0);
  });

  it("debounces saves", () => {
    vi.useFakeTimers();
    const fs = fakeFs();
    const store = new SearchCacheStore("/ud/sc", fs, { debounceMs: 1000 });
    store.for(1)!.add("room:1", [msg(1, "a b")]);
    store.scheduleSave();
    store.scheduleSave();
    expect(fs.files.size).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(fs.files.size).toBe(1);
  });
});
