import { afterEach, describe, expect, it } from "vitest";
import { effectiveLanguage, i18nEnabled } from "../src/lib/i18n-core";
import { applySavedLanguage, getLanguage, setLanguage, t } from "../src/lib/i18n";
import { applyMainLanguage, filterLanguagePatch, getMainLanguage, i18nCaps, setMainLanguage, tm } from "../electron/core/i18n-main";

// 1.0.21: company-only build hides 다국어; UBM_I18N=1 restores it.
const OFF = { LANG: "ja_JP.UTF-8", LC_ALL: "ja_JP.UTF-8" } as Record<string, string | undefined>;
const ON = { ...OFF, UBM_I18N: "1" };

describe("UBM_I18N flag", () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  afterEach(() => {
    setLanguage("ko");
    setMainLanguage("ko");
    if (nav) Object.defineProperty(globalThis, "navigator", nav);
  });

  it("is off unless UBM_I18N is exactly 1", () => {
    expect(i18nEnabled({})).toBe(false);
    expect(i18nEnabled({ UBM_I18N: "0" })).toBe(false);
    expect(i18nEnabled({ UBM_I18N: "true" })).toBe(false);
    expect(i18nCaps(OFF)).toEqual({ enabled: false });
    expect(i18nCaps(ON)).toEqual({ enabled: true });
  });

  it("flag off: locale is always ko even with saved en and OS locale ja", () => {
    Object.defineProperty(globalThis, "navigator", { value: { language: "ja-JP", languages: ["ja-JP"] }, configurable: true });
    for (const saved of ["en", "ja", "zh_TW", "vi", undefined, "bogus"]) expect(effectiveLanguage(saved, false)).toBe("ko");
    expect(applySavedLanguage("en", false)).toBe("ko");
    expect(getLanguage()).toBe("ko");
    expect(t("설정")).toBe("설정");
    expect(applyMainLanguage("en", OFF)).toBe("ko");
    expect(getMainLanguage()).toBe("ko");
    expect(tm("종료")).toBe("종료");
  });

  it("flag off: a previously applied foreign language is reset to ko", () => {
    setLanguage("en");
    setMainLanguage("ja");
    applySavedLanguage("en", false);
    applyMainLanguage("ja", OFF);
    expect(getLanguage()).toBe("ko");
    expect(getMainLanguage()).toBe("ko");
  });

  it("flag on: saved language is honored (OS locale still ignored)", () => {
    expect(applySavedLanguage("en", true)).toBe("en");
    expect(t("설정")).toBe("Settings");
    expect(applyMainLanguage("ja", ON)).toBe("ja");
    expect(tm("종료")).not.toBe("종료");
    expect(applyMainLanguage(undefined, ON)).toBe("ko");
    expect(effectiveLanguage("bogus", true)).toBe("ko");
  });

  it("settings:set drops language patches when off and normalizes them when on", () => {
    expect(filterLanguagePatch({ theme: "dark", language: "en" }, OFF)).toEqual({ theme: "dark" });
    expect(filterLanguagePatch({ theme: "dark" }, OFF)).toEqual({ theme: "dark" });
    expect(filterLanguagePatch({ language: "en" }, ON)).toEqual({ language: "en" });
    expect(filterLanguagePatch({ language: "fr" }, ON)).toEqual({ language: "ko" });
  });
});
