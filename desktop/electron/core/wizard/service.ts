import type { MenuEntry } from "../portal";
import { buildWizardIndex, type GetJson } from "./index";
import { scoreMatch } from "./match";
import { expandQuery } from "./synonyms";
import { sortBrowseHits, sortSearchHits } from "./sort";
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

  /** Inject/replace index (tests / offline). */
  setItems(items: WizardItem[]) {
    this.items = items;
  }

  list(): WizardItem[] {
    return this.items;
  }

  search(query: string, limit = 20): WizardHit[] {
    const prefs = this.store.get();
    const q = query.trim();

    if (!q) {
      const hits: WizardHit[] = this.items.map((it) => {
        const pinned = prefs.pins.includes(it.id);
        const usage = prefs.usage[it.id] || 0;
        const lastUsedAt = prefs.lastUsed[it.id] || 0;
        return {
          ...it,
          score: pinned ? 1 : lastUsedAt ? 0.5 : 0,
          reason: pinned ? "pin" : lastUsedAt ? "recent" : usage ? "usage" : "index",
          pinned,
          usage,
          lastUsedAt,
        };
      });
      return sortBrowseHits(hits, prefs.pins).slice(0, limit);
    }

    const queries = expandQuery(q);
    const hits: WizardHit[] = [];
    for (const it of this.items) {
      let best = { score: 0, reason: "none" };
      for (const qq of queries) {
        const s = scoreMatch(qq, it.title, it.aliases);
        if (s.score > best.score) best = s;
      }
      if (best.score <= 0) continue;
      hits.push({
        ...it,
        score: best.score,
        reason: best.reason,
        pinned: prefs.pins.includes(it.id),
        usage: prefs.usage[it.id] || 0,
        lastUsedAt: prefs.lastUsed[it.id] || 0,
      });
    }
    return sortSearchHits(hits, prefs.pins).slice(0, limit);
  }

  pin(id: string, on: boolean) {
    return this.store.setPinned(id, on);
  }

  recordOpen(id: string) {
    return this.store.recordUse(id);
  }
}
