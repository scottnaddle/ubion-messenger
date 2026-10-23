import { afterEach, describe, expect, it, vi } from "vitest";
import { DaouClient, HttpError } from "../electron/core/daou-client";
import {
  FAVORITE_PATH, favoriteBody, favoritePath, favoritesFromResponse, parseFavoriteUsers,
  parseFavorites, parseFavoritesResponse,
} from "../electron/core/favorites";

const reply = (text = "", status = 200) =>
  new Response(text, { status, headers: { "content-type": "application/json" } });

function client() {
  const c = new DaouClient("https://daou.example");
  c.user = { id: 42, repId: 42, name: "나", loginId: "me", companyId: 1 };
  return c;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("favorites (fake network)", () => {
  it("builds exactly one id per body", () => {
    expect(favoriteBody(3)).toEqual({ ids: [3] });
    expect(favoriteBody("4")).toEqual({ ids: [4] });
    expect(JSON.stringify(favoriteBody(9))).toBe('{"ids":[9]}');
    expect(() => favoriteBody(0)).toThrow();
    expect(() => favoriteBody("x")).toThrow();
  });

  it("builds the GET path with userSeq", () => {
    expect(FAVORITE_PATH).toBe("/api/user/favorite");
    expect(favoritePath(42)).toBe("/api/user/favorite?userSeq=42");
  });

  it("parses data users tolerating id/userId/userSeq and garbage", () => {
    const res = {
      data: [
        { id: 1, name: "A", position: "사원", thumbnail: "a.png", departmentIds: [10] },
        { userId: "2", userName: "B", jobTitle: "대리", userImage: "b.png" },
        { userSeq: 3, memberName: "C" },
        { id: 1, name: "duplicate" },
        { id: "bad" },
        null,
      ],
    };
    const list = parseFavorites(res);
    expect(list.map((u) => u.userId)).toEqual([1, 2, 3]);
    expect(list[0]).toMatchObject({ userId: 1, name: "A", position: "사원", thumbnail: "a.png", departmentIds: [10] });
    expect(list[1]).toMatchObject({ userId: 2, name: "B", position: "대리", thumbnail: "b.png" });
    expect(list[2]).toMatchObject({ userId: 3, name: "C", departmentIds: [] });
    expect(parseFavoriteUsers(res)).toEqual(list);
    expect(parseFavoritesResponse(res)).toEqual(list);
    expect(favoritesFromResponse(res)).toEqual(list);
    expect(parseFavorites([{ userSeq: 5 }]).map((u) => u.userId)).toEqual([5]);
    expect(parseFavorites({ data: { data: [{ id: 6 }] } }).map((u) => u.userId)).toEqual([6]);
    expect(parseFavorites(null)).toEqual([]);
  });

  it("GETs the exact list URL", async () => {
    const f = vi.fn(async () => reply('{"data":[{"userSeq":5,"name":"E"}]}'));
    vi.stubGlobal("fetch", f);
    await expect(client().listFavorites()).resolves.toMatchObject([{ userId: 5, name: "E" }]);
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://daou.example/api/user/favorite?userSeq=42");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("POSTs and DELETEs one id with a JSON body and content-type", async () => {
    const f = vi.fn(async () => reply('{"code":"200"}'));
    vi.stubGlobal("fetch", f);
    const c = client();

    await expect(c.addFavorite(7)).resolves.toEqual({ ok: true });
    let [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://daou.example/api/user/favorite?userSeq=42");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body.toString())).toEqual({ ids: [7] });

    await expect(c.removeFavorite(7)).resolves.toEqual({ ok: true });
    [url, init] = f.mock.calls[1] as any;
    expect(url).toBe("https://daou.example/api/user/favorite?userSeq=42");
    expect(init.method).toBe("DELETE");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body.toString())).toEqual({ ids: [7] });
  });

  it("rejects invalid ids without calling fetch and surfaces HTTP errors", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(client().addFavorite(0)).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();

    vi.stubGlobal("fetch", vi.fn(async () => reply('{"message":"nope"}', 403)));
    const err = await client().removeFavorite(1).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
  });
});
