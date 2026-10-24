const BLOCKED_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input", "button", "link", "meta",
  "base", "noscript", "template", "svg", "math", "frame", "frameset",
]);

const ALLOWED_TAGS = new Set([
  "a", "abbr", "address", "article", "aside", "b", "blockquote", "br", "caption", "center", "cite",
  "code", "col", "colgroup", "dd", "del", "details", "div", "dl", "dt", "em", "figcaption", "figure",
  "font", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd",
  "li", "main", "mark", "ol", "p", "pre", "q", "s", "section", "small", "span", "strike", "strong",
  "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);

const ALLOWED_ATTRS = new Set([
  "href", "src", "alt", "title", "width", "height", "colspan", "rowspan", "style", "class",
  "align", "valign", "border", "cellpadding", "cellspacing", "bgcolor", "color", "face", "size",
  "dir", "lang", "target", "rel",
]);

export function isBlockedTag(tag: string): boolean {
  return BLOCKED_TAGS.has(String(tag || "").toLowerCase());
}

export function isAllowedAttr(name: string): boolean {
  const n = String(name || "").toLowerCase();
  return !n.startsWith("on") && ALLOWED_ATTRS.has(n);
}

export function isSafeUrl(raw: string): boolean {
  const v = String(raw ?? "").trim();
  if (!v) return false;
  const compact = v.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
  if (/^(javascript|vbscript|file):/.test(compact)) return false;
  if (compact.startsWith("data:")) return compact.startsWith("data:image/");
  if (/^[a-z][a-z0-9+.-]*:/.test(compact)) return /^(https?|mailto|tel):/.test(compact);
  return true;
}

export function isSafeStyle(raw: string): boolean {
  const v = String(raw ?? "").toLowerCase();
  if (!v.trim()) return false;
  if (/expression\s*\(|javascript:|vbscript:|behavior\s*:/.test(v.replace(/\s+/g, ""))) return false;
  const re = /url\(([^)]*)\)/g;
  for (let m = re.exec(v); m; m = re.exec(v)) {
    const u = m[1].trim().replace(/^['"]|['"]$/g, "");
    if (!isSafeUrl(u)) return false;
  }
  return true;
}

function unwrap(el: Element) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/** Absolute CSS widths (800px, 21cm, …) force a document wider than a phone or narrow pane. */
function isFixedWidth(value: string): boolean {
  const s = String(value || "").trim().toLowerCase();
  if (!s) return false;
  const m = /^(\d*\.?\d+)\s*(px|pt|pc|cm|mm|in|q)?$/.exec(s);
  return !!m && Number(m[1]) > 0;
}

/**
 * Approval bodies are portal-authored forms with legacy fixed widths (`<table width="800">`,
 * `style="width:720px"`, cell `white-space:nowrap`). Run the normal allowlist first, then drop just
 * those layout constraints so the same HTML reflows in a narrow pane. Images keep their declared
 * size; CSS clamps them to the available width.
 */
export function sanitizeApprovalHtml(html: string): string {
  const clean = sanitizeHtml(html);
  if (!clean || typeof DOMParser === "undefined") return clean;
  const doc = new DOMParser().parseFromString(clean, "text/html");
  const body = doc.body;
  if (!body) return clean;
  for (const el of Array.from(body.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (tag !== "img") {
      const w = el.getAttribute("width");
      if (w != null && isFixedWidth(w)) el.removeAttribute("width");
    }
    const style = (el as HTMLElement).style;
    if (!style?.length) continue;
    for (let i = style.length - 1; i >= 0; i--) {
      const prop = style.item(i);
      const value = style.getPropertyValue(prop);
      if (prop === "min-width" || (prop === "width" && tag !== "img" && isFixedWidth(value)) || (prop === "white-space" && /nowrap/i.test(value))) {
        style.removeProperty(prop);
      }
    }
    if (style.length) el.setAttribute("style", style.cssText);
    else el.removeAttribute("style");
  }
  return body.innerHTML;
}

export type MailSanitizeResult = { html: string; blockedImages: number };

/**
 * Mail bodies: same allowlist as sanitizeHtml, plus remote content blocking (tracking pixels) unless
 * `showImages`. Blocked <img> keep their size as an empty placeholder; style url(http…) is dropped.
 * Links get data-ext-href so the renderer can open them in the external browser (never in-app).
 */
export function sanitizeMailHtml(html: string, showImages = false): MailSanitizeResult {
  if (!html || typeof DOMParser === "undefined") return { html: "", blockedImages: 0 };
  const clean = sanitizeHtml(html, { keepRemoteImages: true });
  const doc = new DOMParser().parseFromString(clean, "text/html");
  let blocked = 0;
  for (const img of Array.from(doc.body.querySelectorAll("img"))) {
    const src = img.getAttribute("src") || "";
    if (/^data:image\//i.test(src)) continue;
    if (!showImages) {
      blocked++;
      img.removeAttribute("src");
      img.setAttribute("data-blocked", "1");
      img.setAttribute("alt", img.getAttribute("alt") || "");
    }
  }
  for (const el of Array.from(doc.body.querySelectorAll("[style], [background]"))) {
    el.removeAttribute("background");
    const st = el.getAttribute("style");
    if (st && !showImages && /url\(/i.test(st)) {
      blocked++;
      el.setAttribute("style", st.replace(/url\([^)]*\)/gi, "none"));
    }
  }
  for (const a of Array.from(doc.body.querySelectorAll("a"))) {
    const href = a.getAttribute("href") || "";
    if (/^(https?|mailto):/i.test(href)) a.setAttribute("data-ext-href", href);
    a.removeAttribute("target");
  }
  return { html: doc.body.innerHTML, blockedImages: blocked };
}

export function sanitizeHtml(html: string, opts: { keepRemoteImages?: boolean } = {}): string {
  if (!html) return "";
  if (typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(String(html), "text/html");
  const body = doc.body;
  if (!body) return "";
  for (const el of Array.from(body.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (isBlockedTag(tag)) {
      el.remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      unwrap(el);
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (!isAllowedAttr(name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if ((name === "href" || name === "src") && !isSafeUrl(attr.value)) el.removeAttribute(attr.name);
      else if (name === "style" && !isSafeStyle(attr.value)) el.removeAttribute(attr.name);
    }
    if (tag === "a") {
      el.setAttribute("rel", "noopener noreferrer");
    }
    // Portal-relative images (signature stamps, thumbs) need the portal session cookie and would
    // resolve to file:// in the app — drop them instead of showing broken images.
    if (tag === "img" && !/^(https:\/\/|data:image\/)/i.test(el.getAttribute("src") || "") && !(opts.keepRemoteImages && /^http:\/\//i.test(el.getAttribute("src") || ""))) {
      el.remove();
    }
  }
  return body.innerHTML;
}
