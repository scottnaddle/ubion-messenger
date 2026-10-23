import { describe, expect, it } from "vitest";
import {
  activateTheme, addTheme, checkThemeSize, isCssFileName, isValidThemeId, newThemeId, normalizePreset, normalizeThemeState,
  removeTheme, sanitizeThemeCss, themeFileName, themeNameFromPath, THEME_MAX_BYTES, THEME_PRESETS,
} from "../electron/core/theme";

describe("sanitizeThemeCss", () => {
  it("keeps ordinary CSS untouched", () => {
    const css = ':root { --accent: #e8590c; }\n.rail { background: linear-gradient(#000, #111); }\n.x::before { content: "\\f101"; }';
    expect(sanitizeThemeCss(css)).toEqual({ css, removed: [] });
  });

  it("strips @import in all forms", () => {
    const r = sanitizeThemeCss('@import url("https://evil.example/a.css");\n@IMPORT "b.css" screen;\n:root{--fg:#000}');
    expect(r.css).toBe(":root{--fg:#000}");
    expect(r.removed).toEqual(["@import"]);
  });

  it("neutralizes remote and scripted url(...)", () => {
    const r = sanitizeThemeCss(
      ".a{background:url(https://evil.example/t.png)}.b{background:url( 'http://x/y' )}.c{background:url(\"//cdn.example/z\")}" +
        ".d{background:url(javascript:alert(1))}.e{src:url(file:///etc/passwd)}",
    );
    expect(r.css).toBe(".a{background:none}.b{background:none}.c{background:none}.d{background:none}.e{src:none}");
    expect(r.removed).toEqual(["url()"]);
  });

  it("keeps relative and data: image/font urls", () => {
    const css = ".a{background:url(img/bg.png)}.b{background:url('data:image/png;base64,AAAA')}@font-face{src:url(data:font/woff2;base64,AA)}";
    expect(sanitizeThemeCss(css).css).toBe(css);
  });

  it("refuses data:text/html and other non-image data urls", () => {
    expect(sanitizeThemeCss(".a{background:url(data:text/html,<b>x</b>)}").css).toBe(".a{background:none}");
  });

  it("catches remote strings inside image-set()", () => {
    const r = sanitizeThemeCss('.a{background-image:image-set("https://evil.example/a.png" 1x)}');
    expect(r.css).toBe('.a{background-image:image-set("" 1x)}');
    expect(r.removed).toContain("url()");
  });

  it("removes expression(), behavior, -moz-binding and javascript:", () => {
    const r = sanitizeThemeCss(".a{width:expression(alert(1));behavior:url(x.htc);-moz-binding:url(x.xml#y);color:red}.b{cursor:javascript:x}");
    expect(r.css).not.toMatch(/expression|behavior|binding|javascript/i);
    expect(r.css).toContain("color:red");
    expect(r.removed).toEqual(expect.arrayContaining(["expression()", "behavior", "javascript:"]));
  });

  it("is not fooled by CSS escapes or comments", () => {
    expect(sanitizeThemeCss(".a{background:\\75 rl(https://evil.example/x)}").css).toBe(".a{background:none}");
    expect(sanitizeThemeCss("\\@import 'x.css';.b{}").css).toBe(".b{}");
    expect(sanitizeThemeCss(".a{background:url(/**/https://evil.example)}").css).toBe(".a{background:none}");
    expect(sanitizeThemeCss("@im/* */port 'x.css';").css).not.toMatch(/import/i);
  });

  it("drops BOM, NUL and </style>", () => {
    const r = sanitizeThemeCss("\uFEFF.a{color:red}\u0000</style><script>x</script>");
    expect(r.css.startsWith(".a{color:red}")).toBe(true);
    expect(r.css).not.toMatch(/<\/?style/i);
  });
});

describe("sanitizeThemeCss bypasses", () => {
  const remote = /evil/;
  it.each([
    ['a{background:url("http\\\ns://evil/x.png")}', "line continuation in url string"],
    ['a{background:image-set("http\\\ns://evil/x.png" 1x)}', "line continuation in bare string"],
    [`a{background:image-set("https://evil/x'y.png" 1x)}`, "string holding the other quote"],
    ['a{background:url("ht\\9 tps://evil/x.png")}', "escaped tab in scheme"],
    ["a{background:url(ht\\9 tps://evil/x.png)}", "escaped tab in bare url"],
    ['a{background:url("\\\\/evil/x.png")}', "backslash-slash protocol-relative"],
    ['a{background:image-set("\\\\\\\\evil/x.png" 1x)}', "UNC-ish bare string"],
  ])("blocks %s (%s)", (input) => {
    expect(sanitizeThemeCss(input).css).not.toMatch(remote);
  });

  it("keeps ordinary strings and relative urls", () => {
    const css = 'a::before{content:"note: hi"} b{background:url("img/a.png")}';
    expect(sanitizeThemeCss(css).css).toBe(css);
  });
});

describe("theme helpers", () => {
  it("validates ids and builds safe file names", () => {
    const id = newThemeId(1_700_000_000_000, () => 0.5);
    expect(id).toBe("theme-loyw3v28-7fffff");
    expect(isValidThemeId(id)).toBe(true);
    expect(themeFileName(id)).toBe(`${id}.css`);
    for (const bad of ["../x", "a/b", "", "A", "x.css", "-x", 5, null]) expect(() => themeFileName(bad)).toThrow();
  });

  it("derives names and checks extension/size", () => {
    expect(themeNameFromPath("C:\\Users\\me\\Desktop\\오렌지 테마.CSS")).toBe("오렌지 테마");
    expect(themeNameFromPath("/tmp/.css")).toBe("사용자 테마");
    expect(themeNameFromPath(`/t/${"a".repeat(80)}.css`)).toHaveLength(40);
    expect(isCssFileName("/a/b.css")).toBe(true);
    expect(isCssFileName("/a/b.css.exe")).toBe(false);
    expect(() => checkThemeSize(THEME_MAX_BYTES)).not.toThrow();
    expect(() => checkThemeSize(THEME_MAX_BYTES + 1)).toThrow(/256KB/);
    expect(() => checkThemeSize(NaN)).toThrow();
  });

  it("normalizes persisted state and keeps one enabled theme", () => {
    const st = normalizeThemeState(
      [{ id: "t1", name: " 하나 ", enabled: true }, { id: "t2", name: "", enabled: true }, { id: "../bad", name: "x" }, { id: "t1", name: "dup" }, null],
      "t2",
    );
    expect(st).toEqual({ themes: [{ id: "t1", name: "하나", enabled: false }, { id: "t2", name: "t2", enabled: true }], activeThemeId: "t2" });
    expect(normalizeThemeState("nope", "t9")).toEqual({ themes: [], activeThemeId: "" });
  });

  it("add / activate / remove", () => {
    let st = addTheme({ themes: [], activeThemeId: "" }, { id: "t1", name: "A" });
    st = addTheme(st, { id: "t2", name: "B" });
    st = activateTheme(st.themes, "t2");
    expect(st.themes.map((t) => t.enabled)).toEqual([false, true]);
    expect(activateTheme(st.themes, "missing").activeThemeId).toBe("");
    expect(removeTheme(st, "t1")).toEqual({ themes: [{ id: "t2", name: "B", enabled: true }], activeThemeId: "t2" });
    expect(removeTheme(st, "t2")).toEqual({ themes: [{ id: "t1", name: "A", enabled: false }], activeThemeId: "" });
    expect(() => addTheme(st, { id: "../x", name: "x" })).toThrow();
  });

  it("presets", () => {
    expect(THEME_PRESETS.map((p) => p.name)).toEqual(["기본", "블루", "그린", "퍼플"]);
    expect(normalizePreset("green")).toBe("green");
    expect(normalizePreset("pink")).toBe("default");
  });
});
