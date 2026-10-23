import { describe, expect, it } from "vitest";
import {
  DOC_VIEWER_ENV, PREVIEW_EXTENSIONS, buildPreviewUrl, docViewerServerEnabled, docViewerTemplate,
  isLocalInAppExtension, isPreviewExtension, planPreview, previewTempName,
} from "../electron/core/doc-preview";

const T = "{server}/viewer/doc?cryptId={cryptId}&userSeq={userSeq}";

describe("doc preview extensions", () => {
  it("covers office/hwp/pdf/txt/images", () => {
    for (const e of ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "hwp", "txt", "png", "jpg", "jpeg", "gif"])
      expect(PREVIEW_EXTENSIONS).toContain(e);
  });
  it("matches by name or explicit extention, case-insensitive", () => {
    expect(isPreviewExtension("보고서.HWP")).toBe(true);
    expect(isPreviewExtension("noext", "PDF")).toBe(true);
    expect(isPreviewExtension("a.docx", ".docx")).toBe(true);
    expect(isPreviewExtension("a.zip")).toBe(false);
    expect(isPreviewExtension("a.exe")).toBe(false);
    expect(isPreviewExtension(undefined)).toBe(false);
  });
  it("only pdf/images/txt render in-app locally", () => {
    expect(isLocalInAppExtension("a.pdf")).toBe(true);
    expect(isLocalInAppExtension("a.txt")).toBe(true);
    expect(isLocalInAppExtension("a.png")).toBe(true);
    expect(isLocalInAppExtension("a.docx")).toBe(false);
    expect(isLocalInAppExtension("a.hwp")).toBe(false);
  });
});

describe("DOC_VIEWER_SERVER flag", () => {
  it("is off when the env template is unset or blank", () => {
    expect(docViewerServerEnabled({})).toBe(false);
    expect(docViewerServerEnabled({ [DOC_VIEWER_ENV]: "  " })).toBe(false);
    expect(docViewerServerEnabled({ [DOC_VIEWER_ENV]: T })).toBe(true);
    expect(docViewerTemplate({ [DOC_VIEWER_ENV]: ` ${T} ` })).toBe(T);
  });
});

describe("buildPreviewUrl", () => {
  it("fills placeholders and encodes cryptId/userSeq", () => {
    expect(buildPreviewUrl("https://daou.example/", "a+b/c=", 42, T))
      .toBe("https://daou.example/viewer/doc?cryptId=a%2Bb%2Fc%3D&userSeq=42");
  });
  it("returns null without template or cryptId", () => {
    expect(buildPreviewUrl("https://daou.example", "x", 42, "")).toBeNull();
    expect(buildPreviewUrl("https://daou.example", "", 42, T)).toBeNull();
  });
  it("refuses URLs off the server host (cookies must not leak)", () => {
    expect(buildPreviewUrl("https://daou.example", "x", 42, "https://evil.example/v?id={cryptId}")).toBeNull();
    expect(buildPreviewUrl("https://daou.example", "x", 42, "javascript:alert('{cryptId}')")).toBeNull();
    expect(buildPreviewUrl("https://daou.example", "x", 42, "https://daou.example/v?id={cryptId}")).toBe("https://daou.example/v?id=x");
  });
});

describe("planPreview", () => {
  it("uses the server viewer for every previewable type when enabled", () => {
    expect(planPreview("a.hwp", undefined, true)).toBe("server");
    expect(planPreview("a.pdf", undefined, true)).toBe("server");
  });
  it("falls back locally when the server viewer is off", () => {
    expect(planPreview("a.pdf", undefined, false)).toBe("inapp");
    expect(planPreview("a.txt", undefined, false)).toBe("inapp");
    expect(planPreview("a.xlsx", undefined, false)).toBe("external");
    expect(planPreview("a.zip", undefined, true)).toBe("external");
  });
});

describe("previewTempName", () => {
  it("strips path parts and reserved chars, keeps the extension", () => {
    expect(previewTempName("../../etc/passwd", 5)).toBe("5-passwd");
    expect(previewTempName("C:\\x\\보고서?.pdf", 7)).toBe("7-보고서_.pdf");
    expect(previewTempName("noext", 1, "pdf")).toBe("1-noext.pdf");
    expect(previewTempName("", undefined, "txt")).toBe("x-file.txt");
    expect(previewTempName("...hidden.txt", 2)).toBe("2-hidden.txt");
  });

  it("ends in the planned (explicit) extension and ignores unsafe ext values", () => {
    expect(previewTempName("evil.html", 3, "pdf")).toBe("3-evil.html.pdf");
    expect(previewTempName("evil.exe", 3, "docx")).toBe("3-evil.exe.docx");
    expect(previewTempName("noext", 4, "/../../x")).toBe("4-noext");
  });
});
