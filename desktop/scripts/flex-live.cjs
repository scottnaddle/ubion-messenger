/**
 * Live flex auto-login + API discovery on Scott's Mac.
 * Uses Keychain daou-coco password (never printed). Isolated Electron userData.
 * GET-only after login; never approve/reject.
 */
const { app, BrowserWindow, session } = require("electron");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const B = "https://coco.ubion.co.kr";
const INBOX = "https://flex.team/home/todo/inbox";
const OUT = process.env.FLEX_OUT || path.join(__dirname, "flex-live-out");
const log = [];
const L = (s) => { const line = String(s).replace(/\S+@\S+/g, "<email>").replace(/([?&](?:token|code|key|auth|jwt|password)=)[^&\s]+/gi, "$1<MASK>"); log.push(line); console.log(line); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const pw = execFileSync("security", ["find-generic-password", "-a", "cwdaddy", "-s", "daou-coco", "-w"]).toString().trim();
  const r = await fetch(B + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "cwdaddy", password: pw, captcha: "", returnUrl: "" }) });
  const ck = r.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => c.startsWith("GOSSOcookie=") && c.length > 13).pop().slice(12);
  const email = "cwdaddy@ubion.co.kr";
  L("coco login ok; flex email domain ubion.co.kr");

  const s = session.fromPartition("persist:flexlive");
  await s.clearStorageData();
  await s.cookies.set({ url: B, name: "GOSSOcookie", value: ck });

  const apis = [];
  s.webRequest.onCompleted({ urls: ["*://*.flex.team/*", "*://flex.team/*"] }, (d) => {
    if (/\.(js|css|png|svg|woff2?|ico|jpg|webp|map)(\?|$)/.test(d.url)) return;
    const u = new URL(d.url);
    apis.push({ method: d.method, status: d.statusCode, path: u.pathname + (u.search ? "?…" : "") });
  });

  const w = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { partition: "persist:flexlive", contextIsolation: true, sandbox: true } });
  await w.loadURL(INBOX);
  await sleep(4000);
  L("after inbox load: " + w.webContents.getURL());

  const setVal = `const setVal=(el,v)=>{if(!el)return;const p=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const d=Object.getOwnPropertyDescriptor(p,"value");if(d&&d.set)d.set.call(el,v);else el.value=v;el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));};`;
  const fill = await w.webContents.executeJavaScript(`(async()=>{
    ${setVal}
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const btn=(label)=>[...document.querySelectorAll("button")].find(b=>(b.textContent||"").trim()===label);
    const email=${JSON.stringify(email)};
    const password=${JSON.stringify(pw)};
    let e=document.querySelector('input[type="email"],input:not([type="password"]):not([type="hidden"])');
    if(!e) return "no-form:"+location.href;
    if(!document.querySelector('input[type="password"]')){
      setVal(e,email); const c=btn("계속"); if(!c) return "no-continue"; c.click();
      for(let i=0;i<40;i++){await sleep(250); if(document.querySelector('input[type="password"]')) break;}
    }
    const p=document.querySelector('input[type="password"]');
    if(!p) return "no-password-field";
    setVal(p,password);
    const go=btn("로그인하기")||btn("로그인");
    if(!go) return "no-login-btn";
    go.click();
    return "ok";
  })()`);
  L("fill status: " + fill);

  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const u = w.webContents.getURL();
    if (!u.includes("/auth/login")) { L("left login at t=" + (i * 0.5) + "s → " + u.replace(/[?#].*/, "")); break; }
  }
  await sleep(3000);
  const finalUrl = w.webContents.getURL();
  L("final url: " + finalUrl.replace(/[A-Za-z0-9_-]{24,}/g, "<ID>"));
  fs.writeFileSync(path.join(OUT, "08-flex-inbox.png"), (await w.webContents.capturePage()).toPNG());

  const pageText = await w.webContents.executeJavaScript(`document.body.innerText.slice(0,1500)`);
  L("page text (masked): " + pageText.replace(/\S+@\S+/g, "<email>").slice(0, 800));

  // Probe interesting GET paths seen + candidates
  const seenGet = [...new Set(apis.filter((a) => a.method === "GET").map((a) => a.path.split("?")[0]))];
  L("GET paths seen (" + seenGet.length + "):");
  seenGet.slice(0, 80).forEach((p) => L("  " + p));

  const candidates = [
    ...seenGet.filter((p) => /todo|inbox|approv|pending|count|badge|notification|time-off|time_off|workflow/i.test(p)),
    "/api/v2/todo/inbox",
    "/api-web/v2/todo/inbox",
  ];
  const probe = [];
  for (const p of [...new Set(candidates)].slice(0, 40)) {
    try {
      const res = await s.fetch("https://flex.team" + p, { method: "GET", headers: { accept: "application/json" } });
      const t = await res.text();
      let summary = t.slice(0, 120).replace(/\s+/g, " ");
      if (/password|token|Bearer/i.test(summary)) summary = "<redacted>";
      probe.push({ path: p, status: res.status, len: t.length, head: summary });
    } catch (e) {
      probe.push({ path: p, status: "err", head: String(e.message || e).slice(0, 80) });
    }
  }
  fs.writeFileSync(path.join(OUT, "probe.json"), JSON.stringify(probe, null, 2));
  fs.writeFileSync(path.join(OUT, "apis.json"), JSON.stringify(apis, null, 2));

  // Session persist: new window same partition
  const w2 = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { partition: "persist:flexlive", contextIsolation: true, sandbox: true } });
  await w2.loadURL(INBOX);
  await sleep(4000);
  L("restart window url: " + w2.webContents.getURL().replace(/[A-Za-z0-9_-]{24,}/g, "<ID>"));
  const persisted = !w2.webContents.getURL().includes("/auth/login");
  L("session persisted: " + persisted);
  fs.writeFileSync(path.join(OUT, "log.txt"), log.join("\n"));
  w.close(); w2.close();
  app.quit();
});
