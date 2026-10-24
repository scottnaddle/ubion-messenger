/** One tile in a group-room collage. `src` is empty when the member has no photo URL. */
export type GroupFace = { key: string; name: string; src: string };

export const GROUP_AVATAR_MAX = 4;

type FaceSource = { userId?: number | null; name?: string | null; image?: string | null };

/**
 * Up to four faces for a group-room collage.
 * Photos come first (stable member order), then members with only a name, so a missing URL
 * becomes an initials tile instead of dropping the person. Duplicate ids are skipped.
 * An empty result means the caller should keep the room's single image.
 */
export function groupFaces(
  members: readonly FaceSource[] | null | undefined,
  limit = GROUP_AVATAR_MAX,
): GroupFace[] {
  if (!Array.isArray(members) || limit <= 0) return [];
  const seen = new Set<string>();
  const withPhoto: GroupFace[] = [];
  const without: GroupFace[] = [];
  for (const member of members) {
    if (!member) continue;
    const name = typeof member.name === "string" ? member.name.trim() : "";
    const src = typeof member.image === "string" ? member.image.trim() : "";
    const id = Number(member.userId);
    const key = Number.isFinite(id) && id > 0 ? `id:${id}` : name ? `name:${name}` : "";
    if (!key || seen.has(key)) continue;
    if (!name && !src) continue;
    seen.add(key);
    const face: GroupFace = { key, name: name || "?", src };
    (src ? withPhoto : without).push(face);
  }
  return [...withPhoto, ...without].slice(0, limit);
}
