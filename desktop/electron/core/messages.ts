import type { ChatMessage } from "./types";

const RECONCILE_MS = 120_000;

export function canonMessageId(id: unknown): number | undefined {
  if (id == null || id === "") return undefined;
  const n = typeof id === "number" ? id : Number(id);
  return Number.isFinite(n) ? n : undefined;
}

export function ensureTimestamp(m: ChatMessage, fallback = new Date().toISOString()): ChatMessage {
  if (m.createdAt && !Number.isNaN(new Date(m.createdAt).getTime())) return m;
  return { ...m, createdAt: fallback };
}

export function normalizeMessage(m: ChatMessage): ChatMessage {
  return ensureTimestamp({ ...m, messageId: canonMessageId(m.messageId) });
}

export function upsertMessage(list: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
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

export function dedupeByMessageId(list: ChatMessage[]): ChatMessage[] {
  const seen = new Set<number>();
  const out: ChatMessage[] = [];
  for (const raw of list) {
    const m = normalizeMessage(raw);
    if (m.messageId != null) {
      if (seen.has(m.messageId)) continue;
      seen.add(m.messageId);
    }
    out.push(m);
  }
  return out;
}
