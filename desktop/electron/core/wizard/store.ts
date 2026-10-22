import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { WizardPrefs } from "./types";

function file() {
  return path.join(app.getPath("userData"), "wizard-prefs.json");
}

export class WizardStore {
  private prefs: WizardPrefs = { pins: [], usage: {}, lastUsed: {} };

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
      this.prefs = {
        pins: Array.isArray(raw.pins) ? raw.pins.map(String) : [],
        usage: raw.usage && typeof raw.usage === "object" ? raw.usage : {},
        lastUsed: raw.lastUsed && typeof raw.lastUsed === "object" ? raw.lastUsed : {},
      };
    } catch {
      this.prefs = { pins: [], usage: {}, lastUsed: {} };
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(this.prefs, null, 2), { mode: 0o600 });
  }

  get(): WizardPrefs {
    return {
      pins: [...this.prefs.pins],
      usage: { ...this.prefs.usage },
      lastUsed: { ...this.prefs.lastUsed },
    };
  }

  isPinned(id: string) {
    return this.prefs.pins.includes(id);
  }

  /** Manual pin: on → append to pin order (if new); off → remove. */
  setPinned(id: string, on: boolean) {
    if (on) {
      if (!this.prefs.pins.includes(id)) this.prefs.pins.push(id);
    } else {
      this.prefs.pins = this.prefs.pins.filter((x) => x !== id);
    }
    this.persist();
    return this.get();
  }

  recordUse(id: string, at = Date.now()) {
    this.prefs.usage[id] = (this.prefs.usage[id] || 0) + 1;
    this.prefs.lastUsed[id] = at;
    this.persist();
    return { usage: this.prefs.usage[id], lastUsedAt: at };
  }

  usageOf(id: string) {
    return this.prefs.usage[id] || 0;
  }

  lastUsedOf(id: string) {
    return this.prefs.lastUsed[id] || 0;
  }
}
