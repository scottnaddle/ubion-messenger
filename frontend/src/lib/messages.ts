import type { Message } from "../types";

const RECONCILE_MS = 120_000;

/** Daou REST uses numeric ids; XMPP JSON often sends them as strings. */
export function canonMessageId(id: unknown): number | undefined {
  if (id == null || id === "") return undefined;
  const n = typeof id === "number" ? id : Number(id);
  return Number.isFinite(n) ? n : undefined;
}

export function ensureTimestamp(m: Message, fallback = new Date().toISOString()): Message {
  if (m.createdAt && !Number.isNaN(new Date(m.createdAt).getTime())) return m;
  return { ...m, createdAt: fallback };
}

export function normalizeMessage(m: Message): Message {
  return ensureTimestamp({
    ...m,
    messageId: canonMessageId(m.messageId),
  });
}

export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  let out = existing.map(normalizeMessage);
  for (const raw of incoming) {
    out = upsertMessage(out, raw);
  }
  return out;
}

/** Insert or reconcile one message; never duplicate by canonical server id. */
export function upsertMessage(list: Message[], incoming: Message): Message[] {
  const msg = normalizeMessage(incoming);
  const listN = list.map(normalizeMessage);

  if (msg.messageId != null) {
    const byId = listN.findIndex((x) => x.messageId === msg.messageId);
    if (byId >= 0) {
      const next = [...listN];
      next[byId] = {
        ...next[byId],
        ...msg,
        clientId: next[byId].clientId || msg.clientId,
        createdAt: next[byId].createdAt || msg.createdAt,
        pending: false,
      };
      return next;
    }
    // reconcile optimistic pending (same sender+text, recent)
    const pend = listN.findIndex(
      (x) =>
        x.pending &&
        x.messageId == null &&
        x.message === msg.message &&
        (x.sendUserSeq == null || msg.sendUserSeq == null || x.sendUserSeq === msg.sendUserSeq) &&
        within(x.createdAt, new Date().toISOString(), RECONCILE_MS)
    );
    if (pend >= 0) {
      const next = [...listN];
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
    const byClient = listN.findIndex((x) => x.clientId === msg.clientId);
    if (byClient >= 0) {
      const next = [...listN];
      next[byClient] = {
        ...next[byClient],
        ...msg,
        createdAt: next[byClient].createdAt || msg.createdAt,
      };
      return next;
    }
  }

  // Soft dedupe: identical body+sender within 2s (covers missing/odd ids)
  const soft = listN.findIndex(
    (x) =>
      x.message === msg.message &&
      x.sendUserSeq === msg.sendUserSeq &&
      within(x.createdAt, msg.createdAt, 2000)
  );
  if (soft >= 0) {
    const next = [...listN];
    next[soft] = {
      ...next[soft],
      ...msg,
      messageId: next[soft].messageId ?? msg.messageId,
      clientId: next[soft].clientId || msg.clientId,
      createdAt: next[soft].createdAt || msg.createdAt,
      pending: false,
    };
    return next;
  }

  return [...listN, msg];
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
  for (const raw of list) {
    const m = normalizeMessage(raw);
    if (m.messageId != null) {
      if (seen.has(m.messageId)) {
        // keep the one that already has richer timestamp/clientId
        const idx = out.findIndex((x) => x.messageId === m.messageId);
        if (idx >= 0) {
          out[idx] = {
            ...out[idx],
            ...m,
            createdAt: out[idx].createdAt || m.createdAt,
            clientId: out[idx].clientId || m.clientId,
          };
        }
        continue;
      }
      seen.add(m.messageId);
    }
    out.push(m);
  }
  return out;
}
