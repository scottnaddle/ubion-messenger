import { afterEach, describe, expect, it } from "vitest";
import { DICTIONARIES, LANGUAGES, interpolate, normalizeLanguage, translate } from "../src/lib/i18n-core";
import { getLanguage, setLanguage, t } from "../src/lib/i18n";
import { getMainLanguage, setMainLanguage, tm } from "../electron/core/i18n-main";
import { keysIn, scanKeys } from "../scripts/i18n-keys";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("i18n core", () => {
  afterEach(() => {
    setLanguage("ko");
    setMainLanguage("ko");
  });

  it("normalizes unknown languages to ko", () => {
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("zh_TW")).toBe("zh_TW");
    expect(normalizeLanguage("fr")).toBe("ko");
    expect(normalizeLanguage(undefined)).toBe("ko");
  });

  it("falls back to the Korean key when a translation is missing", () => {
    expect(translate("en", "존재하지 않는 문자열")).toBe("존재하지 않는 문자열");
    expect(translate("ko", "설정")).toBe("설정");
    expect(translate("en", "설정")).toBe("Settings");
  });

  it("interpolates {vars} and leaves unknown placeholders", () => {
    expect(interpolate("읽지 않은 메시지 {n}개", { n: 3 })).toBe("읽지 않은 메시지 3개");
    expect(interpolate("{a}/{b}", { a: 1 })).toBe("1/{b}");
    expect(translate("en", "읽지 않은 메시지 {n}개", { n: 5 })).toBe("5 unread messages");
    expect(translate("vi", "없는 키 {x}", { x: "y" })).toBe("없는 키 y");
  });

  it("renderer t() and main tm() follow the selected language", () => {
    expect(t("설정")).toBe("설정");
    setLanguage("en");
    expect(getLanguage()).toBe("en");
    expect(t("설정")).toBe("Settings");
    setLanguage("bogus");
    expect(getLanguage()).toBe("ko");
    expect(setMainLanguage("ja")).toBe("ja");
    expect(getMainLanguage()).toBe("ja");
    expect(tm("종료")).not.toBe("종료");
  });
});

describe("i18n dictionaries vs source keys", () => {
  const used = scanKeys();
  const source = new Set(used.keys());

  it("scanner reads only literal keys", () => {
    expect(keysIn(`t("가 {n}", { n }); tm("나"); tk("다"); format("라"); x.t("마"); t(label)`)).toEqual(["가 {n}", "나", "다"]);
    expect(source.size).toBeGreaterThan(300);
  });

  for (const lang of LANGUAGES.filter((l) => l !== "ko")) {
    it(`every ${lang} key exists in the Korean source set with matching placeholders`, () => {
      const dict = DICTIONARIES[lang];
      expect(Object.keys(dict).filter((k) => !source.has(k))).toEqual([]);
      const bad = Object.entries(dict).filter(([k, v]) => placeholders(k).join() !== placeholders(v).join()).map(([k]) => k);
      expect(bad).toEqual([]);
      expect(Object.values(dict).filter((v) => !v.trim())).toEqual([]);
    });
  }

  it("en translates every key used in components and menus", () => {
    const missing = [...source].filter((k) => !DICTIONARIES.en[k]).map((k) => `${k} (${used.get(k)!.join(", ")})`);
    expect(missing).toEqual([]);
  });

  it("other languages cover menu / navigation / settings strings", () => {
    const core = [...used].filter(([, files]) => files.some((f) => /(SettingsModal|Sidebar|Menu|rail-tooltip|i18n-main|main)\.tsx?$/.test(f))).map(([k]) => k);
    for (const lang of ["ja", "zh_CN", "zh_TW", "vi"] as const) {
      expect(core.filter((k) => !DICTIONARIES[lang][k]), lang).toEqual([]);
    }
  });
});
