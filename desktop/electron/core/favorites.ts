import type { Person } from "./types";

/**
 * Favorites (v1.0.17).
 * GET    /api/user/favorite?userSeq={me}
 * POST   /api/user/favorite?userSeq={me}  body {"ids":[id]}
 * DELETE /api/user/favorite?userSeq={me}  body {"ids":[id]}
 * Exactly one id per mutation, matching the official client.
 */
export const FAVORITE_PATH = "/api/user/favorite";
export const FAVORITES_PATH = FAVORITE_PATH;
export const FAVORITE_METHODS = { list: "GET", add: "POST", remove: "DELETE" } as const;

export function favoritePath(me: number): string {
  return `${FAVORITE_PATH}?userSeq=${Number(me)}`;
}
export const buildFavoritePath = favoritePath;

/** Request body for one add/remove call: {"ids":[id]}. */
export function favoriteBody(id: unknown): { ids: number[] } {
  const n = typeof id === "number" ? id : typeof id === "string" && id.trim() !== "" ? Number(id) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("올바른 사용자를 선택하세요");
  return { ids: [n] };
}
export const buildFavoriteBody = favoriteBody;
export const favoritesBody = favoriteBody;

function favoriteId(raw: any): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  for (const v of [raw.userId, raw.userSeq, raw.id]) {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return undefined;
}

function str(...values: unknown[]): string {
  for (const v of values) if (typeof v === "string" && v) return v;
  return "";
}

/**
 * Tolerant parser for GET /api/user/favorite.
 * Accepts the server envelope `{data:[…]}`, a bare array, or `{data:{…}}`;
 * a user's id may arrive as id, userId or userSeq.
 */
export function parseFavorites(res: any): Person[] {
  const raw = Array.isArray(res)
    ? res
    : Array.isArray(res?.data)
    ? res.data
    : Array.isArray(res?.data?.data)
    ? res.data.data
    : [];
  const out: Person[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    const u = item && typeof item === "object" && item.user && typeof item.user === "object" ? item.user : item;
    const userId = favoriteId(u);
    if (userId == null || seen.has(userId)) continue;
    seen.add(userId);
    const departmentIds = Array.isArray(u.departmentIds)
      ? u.departmentIds.map(Number).filter(Number.isFinite)
      : Array.isArray(u.depts)
      ? u.depts.map((d: any) => Number(typeof d === "object" ? d.id : d)).filter(Number.isFinite)
      : [];
    out.push({
      userId,
      name: str(u.name, u.userName, u.memberName),
      position: str(u.position, u.jobTitle, u.buddyPosition),
      email: str(u.email),
      thumbnail: str(u.thumbnail, u.userImage, u.profileImage),
      departmentIds,
      ...(str(u.directTel) ? { directTel: str(u.directTel) } : {}),
      ...(str(u.mobileNo) ? { mobileNo: str(u.mobileNo) } : {}),
    });
  }
  return out;
}
export const parseFavoriteUsers = parseFavorites;
export const parseFavoriteList = parseFavorites;
export const parseFavoritesResponse = parseFavorites;
export const favoritesFromResponse = parseFavorites;
export const normalizeFavorites = parseFavorites;
