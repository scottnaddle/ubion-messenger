/**
 * Saved messages on device: the same shape as desktop's userData JSON, kept in the
 * mobile key/value store. Never uploaded.
 */
import { normalizeSavedInput, savedMessageId, type SavedInput, type SavedMessage } from "../../electron/core/saved";
import type { KvStore } from "../platform/storage";

const keyFor = (uid: number) => `savedMessages:${uid}`;

function parse(raw: string | null): SavedMessage[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : [];
    return list.filter(
      (x: unknown) =>
        x && typeof x === "object" &&
        typeof (x as SavedMessage).id === "string" &&
        typeof (x as SavedMessage).roomKey === "string" &&
        typeof (x as SavedMessage).message === "string",
    );
  } catch {
    return [];
  }
}

export async function listSaved(storage: KvStore, uid: number | null | undefined): Promise<SavedMessage[]> {
  if (uid == null || !Number.isSafeInteger(uid) || uid <= 0) return [];
  return parse(await storage.get(keyFor(uid)));
}

export async function addSaved(storage: KvStore, uid: number | null | undefined, input: unknown): Promise<SavedMessage> {
  if (uid == null || !Number.isSafeInteger(uid) || uid <= 0) throw new Error("로그인이 필요합니다");
  const fields: SavedInput = normalizeSavedInput(input);
  const item: SavedMessage = { ...fields, id: savedMessageId(), savedAt: Date.now() };
  const list = [item, ...(await listSaved(storage, uid))].slice(0, 500);
  await storage.set(keyFor(uid), JSON.stringify(list));
  return item;
}

export async function removeSaved(storage: KvStore, uid: number | null | undefined, id: unknown): Promise<{ ok: true }> {
  if (typeof id !== "string" || !id) throw new Error("잘못된 요청입니다");
  if (uid == null || !Number.isSafeInteger(uid) || uid <= 0) return { ok: true };
  const list = (await listSaved(storage, uid)).filter((m) => m.id !== id);
  await storage.set(keyFor(uid), JSON.stringify(list));
  return { ok: true };
}
