import { describe, expect, it } from "vitest";
import { getJson, localStore, memoryStore, preferencesStore, setJson, type PreferencesLike } from "../src/platform/storage";
import { applySettingsPatch, loadMobileSettings, MOBILE_DEFAULTS, saveMobileSettings, SETTINGS_KEY } from "../src/mobile/settings";

function fakeLocalStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const brokenPrefs: PreferencesLike = {
  get: async () => { throw new Error("plugin not implemented"); },
  set: async () => { throw new Error("plugin not implemented"); },
  remove: async () => { throw new Error("plugin not implemented"); },
};

describe("platform storage", () => {
  it("uses Preferences when it works (prefixed keys)", async () => {
    const m = new Map<string, string>();
    const prefs: PreferencesLike = {
      get: async ({ key }) => ({ value: m.get(key) ?? null }),
      set: async ({ key, value }) => void m.set(key, value),
      remove: async ({ key }) => void m.delete(key),
    };
    const s = preferencesStore(prefs, memoryStore());
    await s.set("a", "1");
    expect(m.get("ubm:a")).toBe("1");
    expect(await s.get("a")).toBe("1");
    await s.remove("a");
    expect(await s.get("a")).toBeNull();
  });
  it("falls back to localStorage when the plugin throws", async () => {
    const ls = fakeLocalStorage();
    const s = preferencesStore(brokenPrefs, localStore(ls));
    await s.set("k", "v");
    expect(ls.getItem("ubm:k")).toBe("v");
    expect(await s.get("k")).toBe("v");
    await s.remove("k");
    expect(ls.getItem("ubm:k")).toBeNull();
  });
  it("localStore without localStorage degrades to memory; JSON helpers tolerate garbage", async () => {
    const s = localStore(undefined);
    await setJson(s, "j", { a: 1 });
    expect(await getJson(s, "j")).toEqual({ a: 1 });
    await s.set("bad", "{nope");
    expect(await getJson(s, "bad")).toBeNull();
    expect(await getJson(s, "missing")).toBeNull();
  });
});

describe("mobile settings persistence", () => {
  it("defaults like desktop; password never persisted; hasSavedPassword always false", async () => {
    const store = memoryStore();
    expect((await loadMobileSettings(store)).serverUrl).toBe(MOBILE_DEFAULTS.serverUrl);
    const patched = applySettingsPatch(MOBILE_DEFAULTS, { username: "u", password: "pw", hasSavedPassword: true, theme: "dark" } as any);
    expect(patched.hasSavedPassword).toBe(false);
    expect("password" in patched).toBe(false);
    await saveMobileSettings(store, { ...patched, password: "leak" } as any);
    const raw = (await store.get(SETTINGS_KEY))!;
    expect(raw).not.toContain("pw");
    expect(raw).not.toContain("leak");
    const loaded = await loadMobileSettings(store);
    expect(loaded).toMatchObject({ username: "u", theme: "dark", hasSavedPassword: false });
  });
  it("rememberMe=false clears autoLogin; theme files/language are not settable", () => {
    const s = applySettingsPatch({ ...MOBILE_DEFAULTS, autoLogin: true }, { rememberMe: false, activeThemeId: "x", language: "en" });
    expect(s.autoLogin).toBe(false);
    expect(s.activeThemeId).toBe("");
    expect(s.language).toBe("ko");
  });
});
