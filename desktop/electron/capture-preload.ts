/** Preload for the 화면 캡쳐 overlay window only: image in, selection rect (or null) out. */
import { contextBridge, ipcRenderer } from "electron";
import { CAPTURE_OVERLAY_DONE, CAPTURE_OVERLAY_IMAGE } from "./core/capture";

contextBridge.exposeInMainWorld("captureOverlay", {
  onImage: (cb: (dataUrl: string) => void) => {
    ipcRenderer.once(CAPTURE_OVERLAY_IMAGE, (_e, url: unknown) => {
      if (typeof url === "string") cb(url);
    });
  },
  done: (rect: { x: number; y: number; width: number; height: number } | null) => {
    ipcRenderer.send(
      CAPTURE_OVERLAY_DONE,
      rect ? { x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height) } : null,
    );
  },
});
