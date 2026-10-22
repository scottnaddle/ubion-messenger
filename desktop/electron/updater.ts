import { IS_TEST_BUILD } from "./flavor";
import { app, BrowserWindow, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { autoUpdater } from "electron-updater";
import { checkMacUpdate, RELEASES_PAGE, type UpdateInfo } from "./core/update-check";

export type UpdateStatus =
  | { state: "idle" | "checking" | "none"; current: string; checkedAt?: number }
  | { state: "available"; current: string; version: string; pageUrl: string }
  | { state: "downloading"; current: string; version: string; percent: number }
  | { state: "downloaded"; current: string; version: string; file?: string }
  | { state: "error"; current: string; message: string };

const FOUR_HOURS = 4 * 60 * 60 * 1000;

/**
 * Windows: electron-updater (NSIS, differential via blockmap) – background download, install on restart/quit.
 * macOS (unsigned → Squirrel.Mac can't install): detect via latest-mac.yml, download the arch dmg to
 * ~/Downloads, open it, and show a drag-to-Applications guide.
 */
export class Updater {
  status: UpdateStatus = { state: "idle", current: app.getVersion() };
  private timer: NodeJS.Timeout | null = null;
  private macInfo: UpdateInfo | null = null;
  private win32 = process.platform === "win32";

  constructor(private getWin: () => BrowserWindow | null) {
    if (this.win32) {
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on("checking-for-update", () => this.set({ state: "checking", current: app.getVersion() }));
      autoUpdater.on("update-not-available", () => this.set({ state: "none", current: app.getVersion(), checkedAt: Date.now() }));
      autoUpdater.on("update-available", (i) =>
        this.set({ state: "downloading", current: app.getVersion(), version: i.version, percent: 0 })
      );
      autoUpdater.on("download-progress", (p) => {
        if (this.status.state === "downloading") this.set({ ...this.status, percent: Math.round(p.percent) });
      });
      autoUpdater.on("update-downloaded", (i) => this.set({ state: "downloaded", current: app.getVersion(), version: i.version }));
      autoUpdater.on("error", (e) => this.set({ state: "error", current: app.getVersion(), message: e?.message || "업데이트 오류" }));
    }
  }

  private set(s: UpdateStatus) {
    this.status = s;
    const w = this.getWin();
    if (w && !w.isDestroyed()) w.webContents.send("update:status", s);
  }

  get supported() {
    return !IS_TEST_BUILD && app.isPackaged && (process.platform === "win32" || process.platform === "darwin");
  }

  schedule(enabled: boolean) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!enabled || !this.supported) return;
    setTimeout(() => void this.check(), 15_000);
    this.timer = setInterval(() => void this.check(), FOUR_HOURS);
  }

  async check(): Promise<UpdateStatus> {
    if (!this.supported) {
      this.set({ state: "error", current: app.getVersion(), message: "개발 실행에서는 업데이트를 확인하지 않습니다" });
      return this.status;
    }
    if (this.status.state === "downloading" || this.status.state === "downloaded") return this.status;
    try {
      if (this.win32) {
        await autoUpdater.checkForUpdates();
      } else {
        this.set({ state: "checking", current: app.getVersion() });
        const info = await checkMacUpdate(app.getVersion(), process.arch);
        this.macInfo = info;
        this.set(
          info
            ? { state: "available", current: app.getVersion(), version: info.version, pageUrl: info.pageUrl }
            : { state: "none", current: app.getVersion(), checkedAt: Date.now() }
        );
      }
    } catch (e) {
      this.set({ state: "error", current: app.getVersion(), message: (e as Error).message });
    }
    return this.status;
  }

  /** macOS: download dmg to ~/Downloads with progress, then open it. */
  async downloadMac(): Promise<string | null> {
    const info = this.macInfo;
    if (!info?.dmgUrl) return null;
    this.set({ state: "downloading", current: app.getVersion(), version: info.version, percent: 0 });
    try {
      const res = await fetch(info.dmgUrl, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`다운로드 실패 (HTTP ${res.status})`);
      const total = Number(res.headers.get("content-length") || 0);
      const file = path.join(app.getPath("downloads"), path.basename(new URL(info.dmgUrl).pathname));
      const tmp = file + ".part";
      const out = fs.createWriteStream(tmp);
      let got = 0, lastPct = -1;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(Buffer.from(value))) await new Promise<void>((r) => out.once("drain", () => r()));
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (pct !== lastPct) {
          lastPct = pct;
          this.set({ state: "downloading", current: app.getVersion(), version: info.version, percent: pct });
        }
      }
      await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
      if (total && got !== total) throw new Error("다운로드가 완전하지 않습니다");
      fs.renameSync(tmp, file);
      this.set({ state: "downloaded", current: app.getVersion(), version: info.version, file });
      await shell.openPath(file);
      return file;
    } catch (e) {
      this.set({ state: "error", current: app.getVersion(), message: (e as Error).message });
      return null;
    }
  }

  install() {
    if (this.win32 && this.status.state === "downloaded") {
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
      return true;
    }
    if (process.platform === "darwin" && this.status.state === "downloaded" && this.status.file) {
      void shell.openPath(this.status.file);
      return true;
    }
    return false;
  }

  openReleasePage() {
    return shell.openExternal(this.status.state === "available" ? this.status.pageUrl : RELEASES_PAGE);
  }
}
