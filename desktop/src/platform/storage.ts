/**
 * Small async key/value store: Capacitor Preferences (UserDefaults / SharedPreferences) on device,
 * localStorage fallback (web dev, plugin missing, or plugin call failing).
 * Secrets never go here — passwords/cookies need a keychain-backed plugin (TODO).
 */
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export type PreferencesLike = {
  get(o: { key: string }): Promise<{ value: string | null }>;
  set(o: { key: string; value: string }): Promise<void>;
  remove(o: { key: string }): Promise<void>;
};

const PREFIX = "ubm:";

/** In-memory store, used when even localStorage is unavailable (private mode, tests). */
export function memoryStore(): KvStore {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => void m.set(k, v),
    remove: async (k) => void m.delete(k),
  };
}

export function localStore(ls: Storage | undefined = globalThis.localStorage): KvStore {
  if (!ls) return memoryStore();
  return {
    get: async (k) => {
      try {
        return ls.getItem(PREFIX + k);
      } catch {
        return null;
      }
    },
    set: async (k, v) => {
      try {
        ls.setItem(PREFIX + k, v);
      } catch {
        /* quota / disabled */
      }
    },
    remove: async (k) => {
      try {
        ls.removeItem(PREFIX + k);
      } catch {
        /* ignore */
      }
    },
  };
}

/** Preferences-backed store; every call falls back to `fallback` if the plugin throws. */
export function preferencesStore(prefs: PreferencesLike, fallback: KvStore = localStore()): KvStore {
  return {
    get: async (k) => {
      try {
        return (await prefs.get({ key: PREFIX + k })).value ?? null;
      } catch {
        return fallback.get(k);
      }
    },
    set: async (k, v) => {
      try {
        await prefs.set({ key: PREFIX + k, value: v });
      } catch {
        await fallback.set(k, v);
      }
    },
    remove: async (k) => {
      try {
        await prefs.remove({ key: PREFIX + k });
      } catch {
        await fallback.remove(k);
      }
    },
  };
}

export function platformStorage(): KvStore {
  const native = Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("Preferences");
  return native ? preferencesStore(Preferences) : localStore();
}

export async function getJson<T>(s: KvStore, key: string): Promise<T | null> {
  const raw = await s.get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function setJson(s: KvStore, key: string, value: unknown): Promise<void> {
  return s.set(key, JSON.stringify(value));
}
