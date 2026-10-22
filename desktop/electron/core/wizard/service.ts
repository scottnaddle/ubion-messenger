import type { MenuEntry } from "../portal";
import { buildWizardIndex, type GetJson } from "./index";
import { scoreMatch } from "./match";
import { expandQuery } from "./synonyms";
import { WizardStore } from "./store";
import type { WizardHit, WizardItem } from "./types";

export class WizardService {
  store = new WizardStore();
  private items: WizardItem[] = [];
  private at = 0;

  start() {
    this.store.load();
  }

  async refresh(menuItems: MenuEntry[], get: GetJson) {
    this.items = await buildWizardIndex(menuItems, get);
    this.at = Date.now();
    return this.items.length;
  }

  list(): WizardItem[] {
    return this.items;
  }

  search(query: string, limit = 20): WizardHit[] {
    const prefs = this.store.get();
    const autoPin = new Set(this.store.topUsage(5));
    const q = query.trim();
    const queries = q ? expandQuery(q) : [""];

    let hits: WizardHit[];
    if (!q) {
      // Empty query: pins + frequent + rest
      hits = this.items.map((it) => ({
        ...it,
        score: prefs.pins.includes(it.id) ? 1000 : autoPin.has(it.id) ? 500 + (prefs.usage[it.id] || 0) : prefs.usage[it.id] || 0,
        reason: prefs.pins.includes(it.id) ? "pin" : autoPin.has(it.id) ? "frequent" : "usage",
        pinned: prefs.pins.includes(it.id),
        usage: prefs.usage[it.id] || 0,
      }));
      hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "ko"));
      return hits.slice(0, limit);
    }

    hits = [];
    for (const it of this.items) {
      let best = { score: 0, reason: "none" };
      for (const qq of queries) {
        const s = scoreMatch(qq, it.title, it.aliases);
        if (s.score > best.score) best = s;
      }
      if (best.score <= 0) continue;
      const pinned = prefs.pins.includes(it.id);
      const usage = prefs.usage[it.id] || 0;
      hits.push({
        ...it,
        score: best.score + (pinned ? 15 : 0) + Math.min(10, usage),
        reason: best.reason,
        pinned,
        usage,
      });
    }
    hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "ko"));
    return hits.slice(0, limit);
  }

  pin(id: string, on: boolean) {
    return this.store.setPinned(id, on);
  }

  recordOpen(id: string) {
    return this.store.recordUse(id);
  }
}
