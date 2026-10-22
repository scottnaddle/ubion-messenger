import type { Me, Message, Person, Room } from "./types";

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`${r.status} ${t.slice(0, 200)}`);
  }
  return r.json();
}

export const api = {
  health: () => j<{ ok: boolean; loggedIn: boolean; xmpp: boolean }>("/api/health"),
  login: () => j<{ ok: boolean; user: Me }>("/api/auth/login", { method: "POST" }),
  me: () => j<Me>("/api/me"),
  rooms: () => j<{ rooms: Room[]; count: number }>("/api/rooms"),
  messages: (kind: string, seq: number, size = 40, before?: number) => {
    const q = new URLSearchParams({ size: String(size) });
    if (before) q.set("before", String(before));
    return j<{ messages: Message[] }>(`/api/rooms/${kind}/${seq}/messages?${q}`);
  },
  send: (kind: string, seq: number, text: string, confirmSelf = false) =>
    j<{ ok: boolean; messageId?: number; self?: boolean }>(`/api/rooms/${kind}/${seq}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, confirmSelf }),
    }),
  search: (q: string) => j<{ rooms: Room[]; people: Person[] }>(`/api/search?q=${encodeURIComponent(q)}`),
  thumb: (path: string) => (path ? `/api/proxy?path=${encodeURIComponent(path)}` : ""),
};
