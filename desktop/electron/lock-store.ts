import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { PinRecord } from "./core/lock";

export const LOCK_STORAGE_UNAVAILABLE = "OS 보안 저장소를 사용할 수 없어 잠금을 설정할 수 없습니다.";

function lockFile() {
  return path.join(app.getPath("userData"), "lock.bin");
}

export function lockStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** lockEnabled is derived from the existence of this file. */
export function lockFileExists(): boolean {
  try {
    return fs.statSync(lockFile()).isFile();
  } catch {
    return false;
  }
}

export function loadLockRecord(): PinRecord | null {
  try {
    if (!lockStorageAvailable() || !lockFileExists()) return null;
    const raw = safeStorage.decryptString(fs.readFileSync(lockFile()));
    const rec = JSON.parse(raw);
    if (
      rec && rec.v === 1 &&
      typeof rec.salt === "string" && rec.salt.length > 0 &&
      typeof rec.hash === "string" && rec.hash.length > 0
    ) {
      return { v: 1, salt: rec.salt, hash: rec.hash };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveLockRecord(rec: PinRecord): boolean {
  try {
    if (!lockStorageAvailable()) return false;
    const file = lockFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(rec)), { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort on filesystems without POSIX modes */
    }
    return true;
  } catch {
    return false;
  }
}

export function clearLockRecord() {
  try {
    fs.unlinkSync(lockFile());
  } catch {
    /* already gone */
  }
}
