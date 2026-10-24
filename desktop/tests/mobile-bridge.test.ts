import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Never touch real Capacitor plugins / the network: CapacitorHttp is replaced by an in-memory fake server.
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "ios", isNativePlatform: () => true, isPluginAvailable: () => false },
  CapacitorHttp: { request: vi.fn(async () => { throw new Error("real CapacitorHttp must not be used in tests"); }) },
  registerPlugin: () => ({}),
}));

import { createMobileBridge, UNSUPPORTED, type MobileBridge } from "../src/mobile/bridge";
import { createNativeFetch, type NativeHttp } from "../src/platform/http";
import { memoryStore, type KvStore } from "../src/platform/storage";

const SERVER = "https://daou.example.test";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
type Req = Parameters<NativeHttp["request"]>[0];

function fakeServer() {
  const calls: Req[] = [];
  const buddyMsgs = [
    { messageId: 9, sendUserSeq: 2, sendUserName: "김하늘", message: "이전", createdAt: "2026-10-24T08:00:00+09:00" },
    { messageId: 10, sendUserSeq: 2, sendUserName: "김하늘", message: "안녕하세요", createdAt: "2026-10-24T08:01:00+09:00" },
  ];
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, headers: { "Content-Type": "application/json", ...headers }, data: b64(JSON.stringify(body)) });
  const request = vi.fn(async (o: Req) => {
    calls.push(o);
    const u = new URL(o.url);
    const authed = /GOSSOcookie=tok/.test(String(o.headers?.Cookie || ""));
    const path = u.pathname;
    if (path === "/api/login" && o.method === "POST") {
      const body = JSON.parse(String(o.data));
      if (body.password !== "right-pw") return json(401, { code: "401", message: "아이디 또는 비밀번호가 일치하지 않습니다" });
      return json(200, { code: "200", data: {} }, { "Set-Cookie": "GOSSOcookie=tok; Path=/; HttpOnly, lang=ko; Expires=Wed, 21 Oct 2026 07:28:00 GMT" });
    }
    if (!authed) return { status: 302, headers: { Location: "/login" }, data: "" };
    if (path === "/api/user/session") return json(200, { data: { id: 1, name: "홍길동", loginId: "hong", companyId: 1 } });
    if (path === "/api/chat/new/buddies") {
      const last = buddyMsgs[buddyMsgs.length - 1];
      return json(200, { hasNext: false, data: [
        { buddySeq: 2, buddyRoomSeq: 77, buddyName: "김하늘", message: last.message, messageId: last.messageId, unreadMessageCount: 1, createdAt: last.createdAt },
        { roomSeq: 10, chatRoomName: "TF", message: "회의", messageId: 5, memberCount: 3, createdAt: "2026-10-23T08:00:00+09:00" },
      ] });
    }
    if (path === "/api/chat/buddies/2" && o.method === "GET") return json(200, { data: buddyMsgs });
    if (path === "/api/chat/buddies/2" && o.method === "POST") {
      const form = new URLSearchParams(String(o.data));
      const m = { messageId: buddyMsgs[buddyMsgs.length - 1].messageId + 1, sendUserSeq: 1, sendUserName: "홍길동", message: form.get("message") || "", createdAt: new Date().toISOString() };
      buddyMsgs.push(m);
      return json(200, { data: { messageId: m.messageId } });
    }
    if (/^\/api\/chat\/buddies\/2\/\d+\/before$/.test(path) && o.method === "PUT") return json(200, { code: "200" });
    if (path === "/api/logout") return json(200, {});
    if (path === "/api/chat/message/delete" && o.method === "PUT") return json(200, { code: "200" });
    if (path.startsWith("/api/chat/notice/") && o.method === "PUT") return json(200, { code: "200" });
    if (path.includes("/push") && o.method === "PUT") return json(200, { code: "200" });
    if (path.startsWith("/api/chat/files/") && (o.method === "GET" || !o.method)) {
      return { status: 200, headers: { "Content-Type": "video/mp4" }, data: b64("mp4-bytes") };
    }
    return json(404, { message: "not found" });
  });
  return { request, calls, buddyMsgs };
}

function fakeDoc() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible" as "visible" | "hidden",
    title: "",
    addEventListener: (_t: string, l: () => void) => void listeners.add(l),
    removeEventListener: (_t: string, l: () => void) => void listeners.delete(l),
  };
  return { doc, setVisible(v: boolean) { doc.visibilityState = v ? "visible" : "hidden"; listeners.forEach((l) => l()); } };
}

let server: ReturnType<typeof fakeServer>;
let storage: KvStore;
let mb: MobileBridge;
let events: Array<{ type: string; payload: any }>;
let d: ReturnType<typeof fakeDoc>;

beforeEach(() => {
  server = fakeServer();
  storage = memoryStore();
  d = fakeDoc();
  mb = createMobileBridge({ fetch: createNativeFetch({ request: server.request }), storage, platform: "ios", version: "1.0.22", pollMs: 60_000, doc: d.doc as any });
  events = [];
  mb.bridge.onEvent((e) => events.push(e));
});
afterEach(() => mb.dispose());

const call = <T = any>(ch: string, ...a: unknown[]) => mb.bridge.call<T>(ch, ...a);
const login = () => call("auth:login", { serverUrl: SERVER + "/", username: " hong ", password: "right-pw", rememberMe: true, autoLogin: true });

describe("mobile bridge: settings + auth", () => {
  it("settings:get/set persist through storage without secrets", async () => {
    const s = await call("settings:get");
    expect(s).toMatchObject({ serverUrl: "https://coco.ubion.co.kr", hasSavedPassword: false, closeToTray: false });
    const next = await call("settings:set", { fontSize: 16, password: "nope" });
    expect(next.fontSize).toBe(16);
    expect(await storage.get("settings")).not.toContain("nope");
    expect(mb.bridge.platform).toBe("ios");
    expect(await call("app:info")).toEqual({ version: "1.0.22", platform: "ios", encryption: false });
  });

  it("auth:login validates input like main", async () => {
    await expect(call("auth:login", { serverUrl: "ftp://x", username: "a", password: "p", rememberMe: false, autoLogin: false })).rejects.toThrow("https://");
    await expect(call("auth:login", { serverUrl: SERVER, username: "a", rememberMe: true, autoLogin: true })).rejects.toThrow("비밀번호를 입력하세요");
    expect(server.request).not.toHaveBeenCalled();
  });

  it("logs in over CapacitorHttp, keeps the session cookie in the jar, never stores password/cookie", async () => {
    const u = await login();
    expect(u).toMatchObject({ id: 1, name: "홍길동" });
    const session = server.calls.find((c) => c.url.endsWith("/api/user/session"))!;
    expect(String(session.headers?.Cookie)).toContain("GOSSOcookie=tok");
    expect(server.calls.every((c) => c.disableRedirects === true)).toBe(true);
    expect(await call("auth:state")).toEqual({ user: u, conn: "online" });
    const saved = (await storage.get("settings"))!;
    expect(saved).not.toContain("right-pw");
    expect(saved).not.toContain("tok");
    expect(JSON.parse(saved)).toMatchObject({ serverUrl: SERVER, username: "hong", rememberMe: true, autoLogin: true, hasSavedPassword: false });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["connection", "ready", "rooms"]));
    expect(await call("auth:botUserSeq")).toBe(0);
  });

  it("wrong password surfaces the server message; auth:logout clears state and autoLogin", async () => {
    await expect(call("auth:login", { serverUrl: SERVER, username: "hong", password: "bad", rememberMe: true, autoLogin: true })).rejects.toThrow();
    await login();
    await call("auth:logout");
    expect(await call("auth:state")).toEqual({ user: null, conn: "offline" });
    expect(events.some((e) => e.type === "loggedOut")).toBe(true);
    expect((await call("settings:get")).autoLogin).toBe(false);
  });
});

describe("mobile bridge: rooms + messages", () => {
  it("rooms:list / msg:history / msg:send / msg:markRead route to DaouClient", async () => {
    await login();
    const rooms = await call<any[]>("rooms:list");
    expect(rooms.map((r) => r.key)).toEqual(["buddy:2", "room:10"]);
    const hist = await call<any[]>("msg:history", "buddy:2");
    expect(hist.map((m) => m.messageId)).toEqual([9, 10]);
    const sent = await call("msg:send", "buddy:2", "반가워요");
    expect(sent).toEqual({ messageId: 11 });
    const post = server.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/chat/buddies/2"))!;
    expect(new URLSearchParams(String(post.data)).get("message")).toBe("반가워요");
    await call("msg:markRead", "buddy:2", 11);
    expect(events).toContainEqual({ type: "confirm", payload: { roomKey: "buddy:2", readerSeq: 1, endId: 11 } });
    await expect(call("msg:history", "room:999")).rejects.toThrow("알 수 없는 대화방");
    expect(await call("rooms:members", "buddy:2")).toEqual([]);
    expect(await call("org:presence")).toEqual({});
  });

  it("sync emits new messages for the active room (deduped) and a rooms update", async () => {
    await login();
    await call("rooms:setActive", "buddy:2");
    await call("msg:history", "buddy:2");
    server.buddyMsgs.push({ messageId: 12, sendUserSeq: 2, sendUserName: "김하늘", message: "새 메시지", createdAt: "2026-10-24T09:00:00+09:00" });
    events.length = 0;
    await call("rooms:sync");
    const msgs = events.filter((e) => e.type === "message");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload).toMatchObject({ roomKey: "buddy:2", messageId: 12, roomKind: "buddy", roomSeq: 2, isMine: false });
    expect(events.some((e) => e.type === "rooms")).toBe(true);
    events.length = 0;
    await call("rooms:sync");
    expect(events.filter((e) => e.type === "message")).toHaveLength(0);
  });

  it("polls only while foreground", async () => {
    await login();
    expect(mb.core.polling).toBe(true);
    const focus: boolean[] = [];
    mb.bridge.onFocus((f) => focus.push(f));
    d.setVisible(false);
    expect(mb.core.polling).toBe(false);
    d.setVisible(true);
    expect(mb.core.polling).toBe(true);
    expect(focus).toEqual([false, true]);
  });

  it("network failures map to the desktop's unreachable message", async () => {
    server.request.mockImplementationOnce(async () => { throw new Error("The Internet connection appears to be offline."); });
    await expect(login()).rejects.toThrow("서버에 연결할 수 없습니다");
  });
});

describe("mobile bridge: disabled features", () => {
  it("unknown channels resolve undefined and log only the channel name", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await call("totally:new", { password: "secret" })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0].join(" "))).toContain("totally:new");
    expect(String(warn.mock.calls[0].join(" "))).not.toContain("secret");
    warn.mockRestore();
  });
  it("unported actions reject with a readable reason; caps report disabled", async () => {
    await expect(call("files:sendBuffer", "buddy:2")).rejects.toThrow(UNSUPPORTED);
    await expect(mb.bridge.previewFile("crypt", 1, "a.pdf")).rejects.toThrow(UNSUPPORTED);
    expect(await call("lock:status")).toEqual({ enabled: false, locked: false, timeoutMin: 0 });
    expect(await mb.bridge.reactions.caps()).toEqual({ enabled: true });
    expect(await mb.bridge.polls.caps()).toMatchObject({ enabled: false });
    expect((await mb.bridge.zoom.caps()).enabled).toBe(false);
    expect((await mb.bridge.pubsub.caps()).send).toBe(false);
    expect(await mb.bridge.backup.list()).toEqual([]);
    expect(await mb.bridge.saved.list()).toEqual([]);
    expect(await mb.bridge.theme.css()).toBe("");
    expect((await mb.bridge.search.global(3, { keyword: "x" } as any)).hits).toEqual([]);
  });

  it("deletes, registers a notice, toggles push, edits, and saves messages locally", async () => {
    await login();
    expect(await mb.bridge.deleteChatMessages([10])).toEqual({ ok: true, count: 1 });
    expect(server.calls.some((c) => c.method === "PUT" && c.url.includes("/api/chat/message/delete"))).toBe(true);
    const noticed = await mb.bridge.registerNotice("room:10", 5);
    expect(noticed.key).toBe("room:10");
    expect(server.calls.some((c) => c.method === "PUT" && c.url.includes("/api/chat/notice/10"))).toBe(true);
    await mb.bridge.setRoomPush("buddy:2", false);
    expect(server.calls.some((c) => c.method === "PUT" && c.url.includes("/api/chat/buddies/2/push") && c.url.includes("usePush=false"))).toBe(true);
    expect(await mb.bridge.edit.caps()).toMatchObject({ enabled: true, selfOnly: false });
    const edited = await mb.bridge.edit.edit("buddy:2", 10, "수정본");
    expect(edited.ok).toBe(true);
    const item = await mb.bridge.saved.add({ roomKey: "buddy:2", roomName: "김하늘", message: "안녕", sendUserName: "김하늘" });
    expect((await mb.bridge.saved.list()).some((m) => m.id === item.id)).toBe(true);
    expect(await mb.bridge.saved.remove(item.id)).toEqual({ ok: true });
    expect(await mb.bridge.saved.list()).toEqual([]);
  });

  it("writes a chat file on device and treats a dismissed share sheet as cancel", async () => {
    await login();
    const write = vi.fn(async (_name: string, bytes: Uint8Array) => {
      expect(new TextDecoder().decode(bytes)).toBe("mp4-bytes");
      return { uri: "file:///tmp/clip.mp4", displayPath: "Files/UBION/clip.mp4", name: "clip.mp4", shareToKeep: false };
    });
    const share = vi.fn(async () => "cancelled" as const);
    const extra = createMobileBridge({
      fetch: createNativeFetch({ request: server.request }),
      storage, platform: "ios", version: "1.0.22", pollMs: 60_000, doc: d.doc as any,
      files: { write, share, shareSaved: async () => undefined },
    });
    await extra.bridge.call("auth:login", { serverUrl: SERVER, username: "hong", password: "right-pw", rememberMe: false, autoLogin: false });
    expect(await extra.bridge.call("files:save", "crypt", 10, "clip.mp4", "downloads")).toBe("Files/UBION/clip.mp4");
    expect(share).not.toHaveBeenCalled();
    expect(await extra.bridge.call("files:save", "crypt", 10, "clip.mp4", "saveAs")).toBeNull();
    expect(share).toHaveBeenCalled();
    extra.dispose();
  });
});
