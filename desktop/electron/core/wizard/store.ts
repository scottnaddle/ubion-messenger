import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { WizardPrefs } from "./types";

const DEFAULTS: WizardPrefs = { pins: [], usage: {} };

function file() {
  return path.join(app.getPath("userData"), "wizard-prefs.json");
}

export class WizardStore {
  private prefs: WizardPrefs = { ...DEFAULTS, usage: {} };

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
      this.prefs = {
        pins: Array.isArray(raw.pins) ? raw.pins.map(String) : [],
        usage: raw.usage && typeof raw.usage === "object" ? raw.usage : {},
      };
    } catch {
      this.prefs = { pins: [], usage: {} };
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(this.prefs, null, 2), { mode: 0o600 });
  }

  get(): WizardPrefs {
    return { pins: [...this.prefs.pins], usage: { ...this.prefs.usage } };
  }

  isPinned(id: string) {
    return this.prefs.pins.includes(id);
  }

  setPinned(id: string, on: boolean) {
    const set = new Set(this.prefs.pins);
    if (on) set.add(id);
    else set.delete(id);
    this.prefs.pins = [...set];
    this.persist();
    return this.get();
  }

  recordUse(id: string) {
    this.prefs.usage[id] = (this.prefs.usage[id] || 0) + 1;
    this.persist();
    return this.prefs.usage[id];
  }

  usageOf(id: string) {
    return this.prefs.usage[id] || 0;
  }

  /** Auto-pin candidates: top N by usage (not already manually unpinned — we only auto-surface in sort). */
  topUsage(n = 5): string[] {
    return Object.entries(this.prefs.usage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([id]) => id);
  }
}
