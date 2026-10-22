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

export function sanitizeHtml(html: string): string {
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
    if (tag === "img" && !/^(https:\/\/|data:image\/)/i.test(el.getAttribute("src") || "")) {
      el.remove();
    }
  }
  return body.innerHTML;
}
