import { afterEach, describe, expect, it, vi } from "vitest";
import { DaouClient, HttpError } from "../electron/core/daou-client";
import {
  buildCircleBody, checkPubsubDelete, checkPubsubSend, normalizePubsubTargets, parsePubsubDetail, parsePubsubList,
  pubsubCaps, pubsubDeletePath, pubsubDetailPath, pubsubListPath, pubsubSendEnabled, pubsubSendPath,
  PUBSUB_ALL_REFUSED_TEXT, PUBSUB_MAX_TARGETS, PUBSUB_SEND_DISABLED_TEXT,
} from "../electron/core/pubsub";

const reply = (text = "", status = 200) =>
  new Response(text, { status, headers: { "content-type": "application/json" } });

function client() {
  const c = new DaouClient("https://daou.example");
  c.user = { id: 42, repId: 42, name: "나", loginId: "me", companyId: 1 };
  return c;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("pubsub paths", () => {
  it("builds the circle endpoints", () => {
    expect(pubsubSendPath(42)).toBe("/api/chat/pubsubs/circle?userSeq=42");
    expect(pubsubListPath(0, 42)).toBe("/api/chat/pubsubs/circle?size=10&page=0&userSeq=42");
    expect(pubsubListPath(3, "42")).toBe("/api/chat/pubsubs/circle?size=10&page=3&userSeq=42");
    expect(pubsubListPath(-1, 42)).toBe("/api/chat/pubsubs/circle?size=10&page=0&userSeq=42");
    expect(pubsubDetailPath(9001, 42)).toBe("/api/chat/pubsubs/circle/9001?userSeq=42");
    expect(pubsubDeletePath(9001, 42)).toBe("/api/chat/pubsubs/circle/9001?userSeq=42");
    expect(() => pubsubDetailPath("../x", 42)).toThrow();
    expect(() => pubsubSendPath(0)).toThrow();
  });
});

describe("buildCircleBody", () => {
  it("mirrors the original partial-range body", () => {
    const body = buildCircleBody({ message: "  공지  ", targets: [{ userId: 2, name: "김하늘" }, { userId: "3" }, { userId: 2 }], me: 42 });
    const nodes = [
      { nodeId: 2, nodeType: "user", nodeValue: "김하늘" },
      { nodeId: 3, nodeType: "user", nodeValue: "" },
    ];
    expect(body).toEqual({ userSeq: 42, message: "공지", nodes, accessTarget: { nodes } });
  });

  it("always refuses the all range and bad input", () => {
    expect(() => buildCircleBody({ message: "x", targets: [2], me: 42, range: "all" })).toThrow(PUBSUB_ALL_REFUSED_TEXT);
    expect(() => buildCircleBody({ message: "x", targets: [2], me: 42, range: "everyone" })).toThrow(PUBSUB_ALL_REFUSED_TEXT);
    expect(() => buildCircleBody({ message: "  ", targets: [2], me: 42 })).toThrow("내용");
    expect(() => buildCircleBody({ message: "x", targets: [], me: 42 })).toThrow("대상");
    expect(() => buildCircleBody({ message: "x", targets: [0], me: 42 })).toThrow();
    expect(() => buildCircleBody({ message: "x".repeat(5000), targets: [2], me: 42 })).toThrow();
    const many = Array.from({ length: PUBSUB_MAX_TARGETS + 1 }, (_, i) => i + 1);
    expect(() => normalizePubsubTargets(many)).toThrow(String(PUBSUB_MAX_TARGETS));
  });
});

describe("pubsub guards", () => {
  it("send is disabled unless UBM_PUBSUB_SEND=1", () => {
    expect(pubsubSendEnabled({})).toBe(false);
    expect(pubsubSendEnabled({ UBM_PUBSUB_SEND: "true" })).toBe(false);
    expect(pubsubSendEnabled({ UBM_PUBSUB_SEND: "1" })).toBe(true);
    expect(pubsubCaps({})).toMatchObject({ send: false, delete: false, reason: PUBSUB_SEND_DISABLED_TEXT });
    expect(pubsubCaps({ UBM_PUBSUB_SEND: "1", UBM_SELF_ONLY: "1" })).toMatchObject({ send: true, selfOnly: true });
    expect(() => checkPubsubSend({ enabled: false, selfOnly: false, targets: [2], me: 42 })).toThrow(PUBSUB_SEND_DISABLED_TEXT);
  });

  it("refuses all range even when enabled", () => {
    expect(() => checkPubsubSend({ enabled: true, selfOnly: false, range: "all", targets: [2], me: 42 })).toThrow(PUBSUB_ALL_REFUSED_TEXT);
  });

  it("self-only allows exactly [me]", () => {
    const on = { enabled: true, selfOnly: true, me: 42 };
    expect(checkPubsubSend({ ...on, targets: [{ userId: 42, name: "나" }] })).toEqual([{ userId: 42, name: "나" }]);
    expect(checkPubsubSend({ ...on, targets: [42, 42] })).toEqual([{ userId: 42, name: undefined }]);
    expect(() => checkPubsubSend({ ...on, targets: [2] })).toThrow("안전 모드");
    expect(() => checkPubsubSend({ ...on, targets: [42, 2] })).toThrow("안전 모드");
    expect(checkPubsubSend({ enabled: true, selfOnly: false, targets: [2, 3], me: 42 })).toHaveLength(2);
  });

  it("delete is gated and, in safe mode, limited to items sent only to me", () => {
    const self = parsePubsubDetail({ data: { messageId: 1, message: "m", accessTarget: { nodes: [{ nodeId: 42, nodeType: "user" }] } } })!;
    const other = parsePubsubDetail({ data: { messageId: 2, message: "m", accessTarget: { nodes: [{ nodeId: 2, nodeType: "user" }] } } })!;
    const dept = parsePubsubDetail({ data: { messageId: 3, message: "m", accessTarget: { nodes: [{ nodeId: 42, nodeType: "department" }] } } })!;
    expect(() => checkPubsubDelete({ enabled: false, selfOnly: false, detail: self, me: 42 })).toThrow(PUBSUB_SEND_DISABLED_TEXT);
    expect(() => checkPubsubDelete({ enabled: true, selfOnly: true, detail: self, me: 42 })).not.toThrow();
    expect(() => checkPubsubDelete({ enabled: true, selfOnly: true, detail: other, me: 42 })).toThrow("안전 모드");
    expect(() => checkPubsubDelete({ enabled: true, selfOnly: true, detail: dept, me: 42 })).toThrow("안전 모드");
    expect(() => checkPubsubDelete({ enabled: true, selfOnly: true, detail: { ...self, companyTarget: true }, me: 42 })).toThrow();
    expect(() => checkPubsubDelete({ enabled: true, selfOnly: true, detail: null, me: 42 })).toThrow();
    expect(() => checkPubsubDelete({ enabled: true, selfOnly: false, detail: other, me: 42 })).not.toThrow();
  });
});

describe("pubsub parsing", () => {
  it("parses the sent list page", () => {
    const raw = {
      code: "200",
      data: [
        { messageId: 11, createdAt: "2026-10-22T01:00:00.000Z", message: "공지 1", companyTarget: false, confirmCount: 1, recipientCount: 3 },
        { messageId: "12", message: "공지 2", companyTarget: true, confirmCount: "5", recipientCount: 100 },
        { message: "no id" },
        null,
      ],
      page: { total: 23 },
    };
    const page = parsePubsubList(raw, 1);
    expect(page.items).toEqual([
      { id: 11, message: "공지 1", createdAt: "2026-10-22T01:00:00.000Z", companyTarget: false, confirmCount: 1, recipientCount: 3 },
      { id: 12, message: "공지 2", createdAt: undefined, companyTarget: true, confirmCount: 5, recipientCount: 100 },
    ]);
    expect(page).toMatchObject({ total: 23, page: 1, hasMore: true });
    expect(parsePubsubList(raw, 2).hasMore).toBe(false);
    expect(parsePubsubList(null)).toEqual({ items: [], total: 0, page: 0, hasMore: false });
  });

  it("parses detail with target nodes", () => {
    const d = parsePubsubDetail({
      data: {
        messageId: 11, message: "공지", confirmCount: 1, recipientCount: 2,
        accessTarget: { userImage: "/u.png", nodes: [{ id: 2, nodeValue: "김하늘" }, { nodeId: 3, nodeType: "user", nodeValue: "이서준" }, {}] },
      },
    });
    expect(d).toMatchObject({ id: 11, message: "공지", userImage: "/u.png" });
    expect(d?.nodes).toEqual([
      { nodeId: 2, nodeType: "user", nodeValue: "김하늘" },
      { nodeId: 3, nodeType: "user", nodeValue: "이서준" },
    ]);
    expect(parsePubsubDetail({ data: {} })).toBeNull();
  });
});

describe("DaouClient pubsub", () => {
  it("lists and reads detail via GET", async () => {
    const f = vi.fn(async (url: string) =>
      url.includes("/circle/11") ? reply(JSON.stringify({ data: { messageId: 11, message: "m" } })) : reply(JSON.stringify({ data: [{ messageId: 11 }], page: { total: 1 } }))
    );
    vi.stubGlobal("fetch", f);
    const c = client();
    expect((await c.listPubsubs(0)).items[0].id).toBe(11);
    expect((await c.getPubsub(11)).message).toBe("m");
    expect((f.mock.calls[0] as any)[0]).toBe("https://daou.example/api/chat/pubsubs/circle?size=10&page=0&userSeq=42");
    expect((f.mock.calls[1] as any)[0]).toBe("https://daou.example/api/chat/pubsubs/circle/11?userSeq=42");
  });

  it("refuses to send or delete without UBM_PUBSUB_SEND=1 (no request made)", async () => {
    vi.stubEnv("UBM_PUBSUB_SEND", "");
    const f = vi.fn(async () => reply("{}"));
    vi.stubGlobal("fetch", f);
    await expect(client().sendPubsub("x", [42])).rejects.toThrow(PUBSUB_SEND_DISABLED_TEXT);
    await expect(client().deletePubsub(1)).rejects.toThrow(PUBSUB_SEND_DISABLED_TEXT);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses range all before any request", async () => {
    vi.stubEnv("UBM_PUBSUB_SEND", "1");
    const f = vi.fn(async () => reply("{}"));
    vi.stubGlobal("fetch", f);
    await expect(client().sendPubsub("x", [42], "all")).rejects.toThrow(PUBSUB_ALL_REFUSED_TEXT);
    expect(f).not.toHaveBeenCalled();
  });

  it("POSTs the JSON body when enabled (mocked fetch) and surfaces code errors", async () => {
    vi.stubEnv("UBM_PUBSUB_SEND", "1");
    const f = vi.fn(async () => reply('{"code":"200"}'));
    vi.stubGlobal("fetch", f);
    await expect(client().sendPubsub("hello", [{ userId: 42, name: "나" }])).resolves.toEqual({ ok: true, count: 1 });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://daou.example/api/chat/pubsubs/circle?userSeq=42");
    expect(init.method).toBe("POST");
    const nodes = [{ nodeId: 42, nodeType: "user", nodeValue: "나" }];
    expect(JSON.parse(Buffer.from(init.body).toString("utf8"))).toEqual({ userSeq: 42, message: "hello", nodes, accessTarget: { nodes } });

    vi.stubGlobal("fetch", vi.fn(async () => reply('{"code":"403","message":"권한 없음"}')));
    const err = await client().sendPubsub("hello", [42]).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toBe("권한 없음");
  });
});
