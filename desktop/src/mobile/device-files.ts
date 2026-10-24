/**
 * Capacitor Filesystem + Share. Documents is the iOS Files folder (UIFileSharingEnabled)
 * and Android's public Documents directory. If that write is rejected, the bytes go to
 * Cache and the share sheet is required so the user can still keep them.
 * Paths and file bytes are never logged.
 */
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { isShareCancel, uniqueFileName, type DeviceFiles, type SavedDeviceFile } from "./device-save";

const FOLDER = "UBION";
const remembered = new Map<string, SavedDeviceFile>();

export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x2000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(bytes.length, i + chunk));
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

async function namesIn(directory: Directory, folder: string): Promise<Set<string>> {
  try {
    const listed = await Filesystem.readdir({ path: folder, directory });
    const names = new Set<string>();
    for (const file of listed.files) names.add(file.name);
    return names;
  } catch {
    return new Set();
  }
}

async function writeAt(directory: Directory, path: string, bytes: Uint8Array): Promise<string> {
  await Filesystem.writeFile({
    path,
    data: bytesToBase64(bytes),
    directory,
    recursive: true,
  });
  const { uri } = await Filesystem.getUri({ path, directory });
  return uri;
}

export function createCapacitorFiles(): DeviceFiles {
  return {
    async write(name, bytes) {
      const docsNames = await namesIn(Directory.Documents, FOLDER);
      const safe = uniqueFileName(name, docsNames);
      const docPath = `${FOLDER}/${safe}`;
      try {
        const uri = await writeAt(Directory.Documents, docPath, bytes);
        const saved: SavedDeviceFile = { uri, displayPath: `Files/${docPath}`, name: safe, shareToKeep: false };
        remembered.set(saved.displayPath, saved);
        return saved;
      } catch {
        /* public Documents is not writable on some Android versions */
      }
      const cacheNames = await namesIn(Directory.Cache, FOLDER);
      const cacheName = uniqueFileName(name, cacheNames);
      const cachePath = `${FOLDER}/${cacheName}`;
      const uri = await writeAt(Directory.Cache, cachePath, bytes);
      const saved: SavedDeviceFile = { uri, displayPath: `Cache/${cachePath}`, name: cacheName, shareToKeep: true };
      remembered.set(saved.displayPath, saved);
      return saved;
    },
    async share(file) {
      try {
        await Share.share({ title: file.name, files: [file.uri], dialogTitle: file.name });
        return "shared";
      } catch (e) {
        if (isShareCancel(e)) return "cancelled";
        throw e;
      }
    },
    async shareSaved(displayPath) {
      const file = remembered.get(displayPath);
      if (!file) return;
      await Share.share({ title: file.name, files: [file.uri], dialogTitle: file.name });
    },
  };
}
