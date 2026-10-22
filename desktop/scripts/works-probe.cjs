/** GET-only probe of Works applet endpoints after coco login. Never prints secrets. */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const B = "https://coco.ubion.co.kr";
const OUT = process.env.TODO_OUT || path.join(__dirname, "../../screens-110");
const paths = [
  "/api/works/applets", "/api/works/applet", "/api/works/apps", "/api/works/app",
  "/api/works/my/applets", "/api/works/user/applets", "/api/go/applets", "/api/works",
  "/api/works/menu", "/api/works/home", "/app/works",
];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const pw = execFileSync("security", ["find-generic-password", "-a", "cwdaddy", "-s", "daou-coco", "-w"]).toString().trim();
  const r = await fetch(B + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "cwdaddy", password: pw, captcha: "", returnUrl: "" }),
  });
  const cookie = (r.headers.getSetCookie?.() || [])
    .map((c) => c.split(";")[0])
    .filter((c) => c.startsWith("GOSSOcookie=") && c.length > 13)
    .pop();
  if (!cookie) throw new Error("no cookie");
  const results = [];
  for (const p of paths) {
    try {
      const res = await fetch(B + p, {
        headers: { Cookie: cookie, Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
        redirect: "manual",
      });
      const text = await res.text();
      const snippet = text.slice(0, 200).replace(/\s+/g, " ");
      let names = [];
      try {
        const j = JSON.parse(text);
        const list = Array.isArray(j) ? j : j?.data?.applets || j?.data?.list || j?.data || j?.applets || [];
        if (Array.isArray(list)) names = list.slice(0, 8).map((a) => a.name || a.title || a.appletName).filter(Boolean);
      } catch { /* html */ }
      results.push({ path: p, status: res.status, names, snippet: snippet.slice(0, 120) });
      console.log(p, res.status, names.length ? names.join("|") : snippet.slice(0, 60));
    } catch (e) {
      results.push({ path: p, error: e.message });
      console.log(p, "ERR", e.message);
    }
  }
  fs.writeFileSync(path.join(OUT, "works-probe.json"), JSON.stringify(results, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
