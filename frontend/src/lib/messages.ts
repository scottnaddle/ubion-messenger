import type { Message } from "../types";

const RECONCILE_MS = 30_000;

export function ensureTimestamp(m: Message, fallback = new Date().toISOString()): Message {
  if (m.createdAt && !Number.isNaN(new Date(m.createdAt).getTime())) return m;
  return { ...m, createdAt: fallback };
}

export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  let out = [...existing];
  for (const raw of incoming) {
    out = upsertMessage(out, raw);
  }
  return out;
}

/** Insert or reconcile one message; never duplicate by server id. */
export function upsertMessage(list: Message[], incoming: Message): Message[] {
  const msg = ensureTimestamp(incoming);
  if (msg.messageId != null) {
    const byId = list.findIndex((x) => x.messageId === msg.messageId);
    if (byId >= 0) {
      const next = [...list];
      next[byId] = {
        ...next[byId],
        ...msg,
        clientId: next[byId].clientId || msg.clientId,
        createdAt: next[byId].createdAt || msg.createdAt,
        pending: false,
      };
      return next;
    }
    const pend = list.findIndex(
      (x) =>
        x.pending &&
        !x.messageId &&
        x.message === msg.message &&
        (x.sendUserSeq == null || msg.sendUserSeq == null || x.sendUserSeq === msg.sendUserSeq) &&
        // pending age vs now (echo may lack createdAt / clock skew)
        within(x.createdAt, new Date().toISOString(), RECONCILE_MS)
    );
    if (pend >= 0) {
      const next = [...list];
      next[pend] = {
        ...next[pend],
        ...msg,
        clientId: next[pend].clientId || msg.clientId,
        pending: false,
        createdAt: next[pend].createdAt || msg.createdAt,
      };
      return next;
    }
  } else if (msg.clientId) {
    const byClient = list.findIndex((x) => x.clientId === msg.clientId);
    if (byClient >= 0) {
      const next = [...list];
      next[byClient] = {
        ...next[byClient],
        ...msg,
        createdAt: next[byClient].createdAt || msg.createdAt,
      };
      return next;
    }
  }
  return [...list, msg];
}

function within(a?: string, b?: string, windowMs = RECONCILE_MS): boolean {
  const ta = a ? new Date(a).getTime() : Date.now();
  const tb = b ? new Date(b).getTime() : Date.now();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return true;
  return Math.abs(ta - tb) <= windowMs;
}

export function dedupeByMessageId(list: Message[]): Message[] {
  const seen = new Set<number>();
  const out: Message[] = [];
  for (const m of list) {
    if (m.messageId != null) {
      if (seen.has(m.messageId)) continue;
      seen.add(m.messageId);
    }
    out.push(ensureTimestamp(m));
  }
  return out;
}
