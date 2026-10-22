// Headless screenshot of the renderer with mock data (no real data).
const { chromium } = require("playwright-core");
const http = require("http"), fs = require("fs"), path = require("path");
const root = path.join(__dirname, "../out/renderer");
const srv = http.createServer((q, s) => {
  const p = path.join(root, decodeURIComponent(q.url.split("?")[0]) === "/" ? "index.html" : decodeURIComponent(q.url.split("?")[0]));
  if (!fs.existsSync(p)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { "content-type": p.endsWith(".js") ? "text/javascript" : p.endsWith(".css") ? "text/css" : "text/html" });
  fs.createReadStream(p).pipe(s);
}).listen(5178, async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--lang=ko-KR"] });
  const pg = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "ko-KR" });
  pg.on("pageerror", (e) => console.error("pageerror", e.message));
  const shots = (process.argv[2] || "").split(",").filter(Boolean);
  const targets = shots.length ? shots : ["light:room=buddy:2:/workspace/daou-app/shot-desktop.png"];
  for (const t of targets) {
    const [theme, q, out] = t.split(/:(?=[a-z]+=|\/)/);
    await pg.goto(`http://localhost:5178/?theme=${theme}&${q}`);
    await pg.waitForTimeout(900);
    await pg.screenshot({ path: out });
    console.log("saved", out);
  }
  await b.close(); srv.close();
});
