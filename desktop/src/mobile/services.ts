/**
 * Mobile-side services: UBM bot auth (DM challenge → ubt1 only), reactions, portal mail/approval.
 * Never forwards DaouOffice cookies to bot.ubion.global. Never logs tokens.
 */
import { PortalService } from "../../electron/core/portal";
import { createUbmAuth, withUbmRetry, type UbmAuth, type UbmAuthToken, type UbmTokenStore } from "../../electron/core/ubm-auth";
import {
  createReactionsClient, normalizeEmoji, normalizeMessageId, normalizeMessageIds, normalizeRoomSeq,
  reactionsCaps, type ReactionMap, type ReactionsCaps, type ReactionsResult,
} from "../../electron/core/reactions";
import type { KvStore } from "../platform/storage";
import { getJson, setJson } from "../platform/storage";
import type { MobileCore } from "./core";
import { clearMediaCache, resolveMediaUrl } from "./media";

const UBM_BASE = "https://bot.ubion.global";
const UBM_TOKEN_KEY = "ubmAuthToken";
const UBM_AUTH_EXPIRED = "세션이 만료되었습니다. 다시 로그인하세요.";

const isUbmAuthFailure = (r: { ok: boolean; kind?: string; message?: string }): boolean =>
  !r.ok && (r.kind === "auth" || r.message === UBM_AUTH_EXPIRED);

function tokenStore(storage: KvStore): UbmTokenStore {
  return {
    async load() {
      const v = await getJson<UbmAuthToken>(storage, UBM_TOKEN_KEY);
      return v && typeof v.token === "string" ? v : null;
    },
    async save(value) {
      if (!value) await storage.remove(UBM_TOKEN_KEY);
      else await setJson(storage, UBM_TOKEN_KEY, value);
    },
  };
}

export type MobileServices = {
  ubmAuth: UbmAuth;
  reactionsCaps(): ReactionsCaps;
  reactionsList(roomSeq: number, ids: number[]): Promise<ReactionMap>;
  reactionsToggle(roomSeq: number, messageId: number, emoji: string): Promise<ReactionMap>;
  portal: PortalService;
  mediaUrl(src: string): Promise<string>;
  onLogout(): Promise<void>;
  /** Poll approval/mail counts for rail badges (best-effort). */
  portalBadge(): Promise<{ approval: number; mail: number; noti: number }>;
};

export function createMobileServices(core: MobileCore, storage: KvStore, fetchImpl?: typeof globalThis.fetch): MobileServices {
  const ubmAuth = createUbmAuth({
    baseUrl: UBM_BASE,
    getUserSeq: () => core.user?.id ?? 0,
    readBotDm: async (botUserSeq) => {
      const messages = await core.client.fetchMessages("buddy", botUserSeq, 20);
      return messages.map((m) => ({ text: m.message, senderSeq: m.sendUserSeq }));
    },
    fetch: fetchImpl ?? globalThis.fetch.bind(globalThis),
    store: tokenStore(storage),
  });

  const ubmServerProof = async (): Promise<string> => ubmAuth.getToken();

  const reactions = () =>
    createReactionsClient({
      baseUrl: UBM_BASE,
      getUserSeq: () => core.user?.id ?? 0,
      getSessionHeader: ubmServerProof,
      fetch: fetchImpl ?? globalThis.fetch.bind(globalThis),
    });

  const runReaction = async (run: () => Promise<ReactionsResult>): Promise<ReactionMap> => {
    const r = await withUbmRetry(run, () => ubmAuth.invalidate(), isUbmAuthFailure);
    if (!r.ok) throw new Error(r.message);
    return r.data;
  };

  const portal = new PortalService(
    (path, init) =>
      core.client.request(
        path,
        init?.method === "POST" || init?.method === "PUT"
          ? { method: init.method, json: init.json }
          : { method: "GET" },
      ),
    () => undefined,
  );

  return {
    ubmAuth,
    reactionsCaps: () => reactionsCaps({}), // enabled unless UBM_REACTIONS=0; mobile define process.env={}
    async reactionsList(roomSeq, ids) {
      if (core.user == null) throw new Error("로그인이 필요합니다");
      const seq = normalizeRoomSeq(roomSeq);
      return runReaction(() => reactions().list(seq, normalizeMessageIds(ids)));
    },
    async reactionsToggle(roomSeq, messageId, emoji) {
      if (core.user == null) throw new Error("로그인이 필요합니다");
      const seq = normalizeRoomSeq(roomSeq);
      const mid = normalizeMessageId(messageId);
      const e = normalizeEmoji(emoji);
      return runReaction(() => reactions().toggle(seq, mid, e));
    },
    portal,
    mediaUrl: (src) => resolveMediaUrl(core.client, src),
    async onLogout() {
      clearMediaCache();
      await ubmAuth.logout();
    },
    async portalBadge() {
      try {
        const [counts, mailToday] = await Promise.all([
          portal.approvalCounts().catch(() => ({ todo: 0, upcoming: 0 })),
          portal.mailTodayCount().catch(() => 0),
        ]);
        return { approval: counts.todo || 0, mail: mailToday || 0, noti: 0 };
      } catch {
        return { approval: 0, mail: 0, noti: 0 };
      }
    },
  };
}
