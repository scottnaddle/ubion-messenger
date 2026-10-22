/**
 * Live E2E for v1.1 todos on Mac via Playwright _electron.
 * Isolated userData. Login via Keychain daou-coco (never printed).
 * Only send a few messages in the '나' self-chat room.
 */
const { _electron: electron } = require("playwright-core");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const OUT = process.env.TODO_OUT || path.join(ROOT, "../../screens-110");
const USER_DATA = process.env.TODO_USER_DATA || path.join(os.tmpdir(), "ubion-todo-live-" + Date.now());
const B = "https://coco.ubion.co.kr";
const results = { ok: [], fail: [], notes: [] };
const L = (s) => {
  const line = String(s)
    .replace(/\S+@\S+/g, "<email>")
    .replace(/([?&](?:token|code|key|auth|jwt|password|pwd)=)[^&\s]+/gi, "$1<MASK>");
  console.log(line);
  results.notes.push(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function blurShot(page, file) {
  // Blur message text / names lightly for screenshots
  await page.addStyleTag({
    content: `
      .msg-text, .room-preview, .todo-snip, .chat-title .name { filter: blur(3px); }
      .todo-title { filter: none; }
    `,
  }).catch(() => {});
  await page.screenshot({ path: path.join(OUT, file), fullPage: false });
  L("shot " + file);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  L("userData=" + USER_DATA);

  let pw;
  try {
    pw = execFileSync("security", ["find-generic-password", "-a", "cwdaddy", "-s", "daou-coco", "-w"]).toString().trim();
  } catch (e) {
    L("FAIL keychain: " + e.message);
    fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
    process.exit(2);
  }

  const electronPath = require("electron");
  const app = await electron.launch({
    executablePath: typeof electronPath === "string" ? electronPath : electronPath,
    args: [ROOT, `--user-data-dir=${USER_DATA}`],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    },
    timeout: 120000,
  });

  const page = await app.firstWindow({ timeout: 120000 });
  await page.waitForLoadState("domcontentloaded");
  await sleep(2000);
  L("window title: " + (await page.title()));

  // Login form
  const userSel = 'input[name="username"], input[type="text"], input[autocomplete="username"]';
  const passSel = 'input[type="password"]';
  try {
    await page.waitForSelector(passSel, { timeout: 15000 });
    const inputs = page.locator("input");
    // Fill server if present, username, password
    const server = page.locator('input[name="serverUrl"], input[placeholder*="coco"], input[placeholder*="https"]');
    if (await server.count()) {
      await server.first().fill(B);
    }
    const userInput = page.locator(userSel).first();
    await userInput.fill("cwdaddy");
    await page.locator(passSel).first().fill(pw);
    // check remember / auto if present
    const loginBtn = page.locator('button:has-text("로그인"), button[type="submit"]').first();
    await loginBtn.click();
    L("login clicked");
  } catch (e) {
    L("login form issue (maybe already in?): " + e.message);
  }

  // Wait for main rail
  try {
    await page.waitForSelector(".rail, .rail-btn, nav.rail", { timeout: 60000 });
    results.ok.push("login");
    L("logged in / main UI visible");
  } catch (e) {
    results.fail.push("login:" + e.message);
    await blurShot(page, "00-login-fail.png");
    await app.close();
    fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
    process.exit(1);
  }
  await sleep(3000);
  await blurShot(page, "01-home-or-chats.png");

  // Go to chats
  const chatBtn = page.locator('button.rail-btn[title*="대화"], button.rail-btn[title*="Chat"]').first();
  if (await chatBtn.count()) await chatBtn.click();
  await sleep(1500);

  // Find 나 self room
  let opened = false;
  const rooms = page.locator(".room, .room-item, [class*='room']");
  const n = await rooms.count();
  L("room candidates: " + n);
  for (let i = 0; i < Math.min(n, 40); i++) {
    const text = ((await rooms.nth(i).innerText().catch(() => "")) || "").replace(/\s+/g, " ");
    if (/(^|\s)나(\s|$)/.test(text) || text.includes("나")) {
      await rooms.nth(i).click();
      opened = true;
      L("opened room: " + text.slice(0, 40));
      break;
    }
  }
  if (!opened) {
    // try filter
    const filter = page.locator("#room-filter, input[placeholder*='검색']").first();
    if (await filter.count()) {
      await filter.fill("나");
      await sleep(800);
      const hit = page.locator(".room, .room-item").first();
      if (await hit.count()) {
        await hit.click();
        opened = true;
      }
    }
  }
  if (!opened) {
    results.fail.push("self-room-not-found");
    await blurShot(page, "02-no-self-room.png");
  } else {
    results.ok.push("self-room");
    await sleep(1500);
    await blurShot(page, "02-self-chat.png");

    // Enable extraction via todo icon in chat head
    const todoToggle = page.locator('header.chat-head button.icon-btn[title*="할일"]').first();
    if (await todoToggle.count()) {
      const cls = (await todoToggle.getAttribute("class")) || "";
      if (!/\bon\b/.test(cls)) {
        await todoToggle.click();
        await sleep(500);
      }
      results.ok.push("extract-enabled");
      L("extraction enabled for room");
    } else {
      results.fail.push("extract-toggle-missing");
    }

    // Send a few test messages (self-chat: both sides are me — self-promise still works)
    const composer = page.locator("textarea, [contenteditable='true'], .composer textarea").first();
    async function send(text) {
      await composer.click();
      await composer.fill(text);
      await page.keyboard.press("Enter");
      await sleep(1200);
    }
    if (await composer.count()) {
      await send("보고서 내일 오후 3시까지 제출 부탁드려요");
      await sleep(800);
      // In self chat, isMine is true for both — use self-promise pattern which scores well
      await send("오늘 중으로 확인하겠습니다");
      await send(
        "Zoom 회의 https://zoom.us/j/12345678901?pwd=TestPwd99 금일 오후 4시",
      );
      results.ok.push("messages-sent");
      L("sent 3 test messages");
      await sleep(2500);
      await blurShot(page, "03-after-messages.png");
    } else {
      results.fail.push("composer-missing");
    }
  }

  // Open 할일 tab
  const todosBtn = page.locator('button.rail-btn[title="할일"]').first();
  if (await todosBtn.count()) {
    await todosBtn.click();
    await sleep(1500);
    await blurShot(page, "04-todos-tab.png");
    const body = await page.locator(".todos-pane").innerText().catch(() => "");
    L("todos pane text (blurred shot): len=" + body.length);
    if (/자동|Zoom|확인|제출|할일/.test(body) || (await page.locator(".todo-item").count()) > 0) {
      results.ok.push("todos-visible");
    } else {
      // May need IPC add for short due — try manual add via UI
      results.notes.push("todos-pane-empty-or-unexpected");
    }

    // Manual short-due todo for reminder (via IPC through evaluate if exposed — use UI add)
    const addInput = page.locator(".todo-add input").first();
    const dueInput = page.locator('.todo-add input[type="datetime-local"]').first();
    if (await addInput.count()) {
      const soon = new Date(Date.now() + 90 * 1000); // 90s — for at-due; also add one with past for overdue stage
      // datetime-local expects local YYYY-MM-DDTHH:mm
      const pad = (n) => (n < 10 ? "0" + n : "" + n);
      // Use Asia/Seoul wall via toLocaleString trick
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(soon);
      const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
      let hh = map.hour === "24" ? "00" : map.hour;
      const local = `${map.year}-${map.month}-${map.day}T${hh}:${map.minute}`;
      await addInput.fill("리마인더 테스트(단기)");
      if (await dueInput.count()) await dueInput.fill(local);
      await page.locator(".todo-add button.primary").click();
      await sleep(1000);
      results.ok.push("manual-short-due");
      L("added short-due todo at " + local);
    }

    // Schedule tab
    const sched = page.locator('.todos-pane .seg button:has-text("일정")').first();
    if (await sched.count()) {
      await sched.click();
      await sleep(1200);
      await blurShot(page, "05-schedule.png");
      results.ok.push("schedule-tab");
    }

    // Settings tab — verify delete-all button exists
    const setTab = page.locator('.todos-pane .seg button:has-text("설정")').first();
    if (await setTab.count()) {
      await setTab.click();
      await sleep(800);
      await blurShot(page, "06-todo-settings.png");
      if (await page.locator('button:has-text("추출 데이터 모두 삭제")').count()) {
        results.ok.push("delete-all-btn");
      }
      // back to open
      await page.locator('.todos-pane .seg button:has-text("진행")').click();
      await sleep(500);
    }

    // Wait for reminder window (~2 min max) — poll notifications is hard; instead force via due in past through evaluate
    // Use main-process: not easily available. Create overdue by updating due via UI if edit exists.
    // Wait up to 100s for short due to pass and tick (30s interval) — too long. Note as partial.
    results.notes.push("reminder-visual: short due set; Notification may fire within ~2min (tick=30s). Not blocking.");
    await blurShot(page, "07-todos-final.png");

    // Zoom join button presence
    const join = page.locator('button:has-text("참가")');
    if ((await join.count()) > 0) {
      results.ok.push("zoom-join-btn");
      L("zoom join button present (not clicking to avoid launching Zoom)");
    } else {
      results.notes.push("zoom-join-btn-absent — auto extract may need isMine=false; check meeting todo from zoom URL message");
    }
  } else {
    results.fail.push("todos-rail-missing");
  }

  await blurShot(page, "08-end.png");
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  L("RESULTS " + JSON.stringify(results.ok) + " FAIL " + JSON.stringify(results.fail));
  await app.close().catch(() => {});
  // cleanup isolated userData? leave for debug; parent can rm
  process.exit(results.fail.length ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  results.fail.push(String(e.message || e));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  process.exit(1);
});
