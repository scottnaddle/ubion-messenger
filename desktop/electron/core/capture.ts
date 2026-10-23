/** 화면 캡쳐: pure helpers for the main-process region capture (overlay → crop → staged attach). */

export const CAPTURE_START = "capture:start";
/** Overlay → main (ipcRenderer.send); only accepted from the overlay's own webContents. */
export const CAPTURE_OVERLAY_DONE = "capture:overlay-done";
/** Main → overlay: the frozen screen image to select on. */
export const CAPTURE_OVERLAY_IMAGE = "capture:overlay-image";
export const CAPTURE_FILE_PREFIX = "do-messenger_screenshot_";
/** Selections smaller than this (in DIP) are treated as a click, not a region. */
export const CAPTURE_MIN_SIZE = 3;
export const CAPTURE_PERMISSION_ERROR =
  "화면 캡쳐 권한이 없습니다. 시스템 설정 > 개인정보 보호 및 보안 > 화면 기록에서 UBION Messenger를 허용한 뒤 앱을 다시 시작하세요.";

export type CaptureRect = { x: number; y: number; width: number; height: number };
export type CaptureResult = { name: string; type: "image/png"; data: Uint8Array; width: number; height: number };

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** do-messenger_screenshot_YYYYMMDDHHmmss.png in local time (same name as the original client). */
export function captureFileName(d: Date = new Date()): string {
  const stamp =
    pad(d.getFullYear(), 4) + pad(d.getMonth() + 1) + pad(d.getDate()) +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  return `${CAPTURE_FILE_PREFIX}${stamp}.png`;
}

/**
 * Overlay selection (DIP, relative to the display, width/height may be negative when dragged
 * up/left) → integer pixel rect inside the captured image. `scaleX/scaleY` = image px per DIP.
 * Returns null for invalid or too-small selections.
 */
export function normalizeCropRect(
  rect: unknown,
  image: { width: number; height: number },
  scale: number | { x: number; y: number },
): CaptureRect | null {
  if (!rect || typeof rect !== "object") return null;
  const r = rect as Record<string, unknown>;
  const [x, y, w, h] = [r.x, r.y, r.width, r.height].map(Number);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  const sx = typeof scale === "number" ? scale : scale.x;
  const sy = typeof scale === "number" ? scale : scale.y;
  if (!(sx > 0) || !(sy > 0) || !Number.isFinite(sx) || !Number.isFinite(sy)) return null;
  if (Math.abs(w) < CAPTURE_MIN_SIZE || Math.abs(h) < CAPTURE_MIN_SIZE) return null;
  const iw = Math.max(0, Math.floor(image.width));
  const ih = Math.max(0, Math.floor(image.height));
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  const left = clamp(Math.floor(Math.min(x, x + w) * sx), iw);
  const right = clamp(Math.ceil(Math.max(x, x + w) * sx), iw);
  const top = clamp(Math.floor(Math.min(y, y + h) * sy), ih);
  const bottom = clamp(Math.ceil(Math.max(y, y + h) * sy), ih);
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Image px per DIP, from the actual thumbnail size (more robust than display.scaleFactor alone). */
export function captureScale(
  image: { width: number; height: number },
  bounds: { width: number; height: number },
  fallback = 1,
): { x: number; y: number } {
  const x = bounds.width > 0 && image.width > 0 ? image.width / bounds.width : fallback;
  const y = bounds.height > 0 && image.height > 0 ? image.height / bounds.height : fallback;
  return { x, y };
}

/** Thumbnail size to request from desktopCapturer: the display at native resolution. */
export function captureThumbnailSize(size: { width: number; height: number }, scaleFactor: number) {
  const s = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  return { width: Math.round(size.width * s), height: Math.round(size.height * s) };
}

/** macOS: getMediaAccessStatus('screen') must be "granted"; other platforms need no permission. */
export function capturePermissionError(platform: string, status?: string): string | null {
  if (platform !== "darwin") return null;
  return status === "granted" ? null : CAPTURE_PERMISSION_ERROR;
}

/** Pick the desktopCapturer source for a display; falls back to the only source when ids are missing. */
export function pickScreenSource<T extends { display_id?: string }>(sources: readonly T[], displayId: number | string): T | null {
  const id = String(displayId);
  return sources.find((s) => s.display_id === id) ?? (sources.length === 1 ? sources[0] : null);
}

/** Self-contained overlay page (loaded as a data: URL, scripts limited by CSP to this inline code). */
export function captureOverlayHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;cursor:crosshair;user-select:none;background:transparent}
#shot{position:fixed;inset:0;width:100%;height:100%;display:none;pointer-events:none}
#dim{position:fixed;inset:0;background:rgba(0,0,0,.35)}
#sel{position:fixed;display:none;outline:1px solid #fff;box-shadow:0 0 0 1px #2b6cff,0 0 0 9999px rgba(0,0,0,.35)}
#hint{position:fixed;left:50%;top:24px;transform:translateX(-50%);padding:8px 14px;border-radius:8px;background:rgba(20,22,28,.85);color:#fff;font:13px -apple-system,"Segoe UI","Malgun Gothic",sans-serif;pointer-events:none}
#size{position:fixed;display:none;padding:2px 6px;border-radius:4px;background:rgba(20,22,28,.85);color:#fff;font:11px monospace;pointer-events:none}
body.drag #dim{display:none}
</style></head><body>
<img id="shot" alt=""><div id="dim"></div><div id="sel"></div><div id="size"></div>
<div id="hint">드래그해서 캡쳐할 영역을 선택하세요 · Esc 취소</div>
<script>
(function(){
  var bridge = window.captureOverlay, shot = document.getElementById("shot"), sel = document.getElementById("sel"),
      size = document.getElementById("size"), hint = document.getElementById("hint"), start = null, finished = false;
  function finish(rect){ if (finished) return; finished = true; bridge.done(rect); }
  bridge.onImage(function(url){ shot.src = url; shot.style.display = "block"; });
  function box(e){ return { x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), width: Math.abs(e.clientX - start.x), height: Math.abs(e.clientY - start.y) }; }
  addEventListener("keydown", function(e){ if (e.key === "Escape") { e.preventDefault(); finish(null); } });
  addEventListener("contextmenu", function(e){ e.preventDefault(); finish(null); });
  addEventListener("mousedown", function(e){
    if (e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY }; hint.style.display = "none"; document.body.classList.add("drag");
  });
  addEventListener("mousemove", function(e){
    if (!start) return;
    var r = box(e);
    sel.style.display = "block"; sel.style.left = r.x + "px"; sel.style.top = r.y + "px"; sel.style.width = r.width + "px"; sel.style.height = r.height + "px";
    size.style.display = "block"; size.textContent = Math.round(r.width) + " × " + Math.round(r.height);
    size.style.left = r.x + "px"; size.style.top = Math.max(0, r.y - 22) + "px";
  });
  addEventListener("mouseup", function(e){
    if (!start || e.button !== 0) return;
    var r = box(e); start = null;
    if (r.width < ${CAPTURE_MIN_SIZE} || r.height < ${CAPTURE_MIN_SIZE}) {
      sel.style.display = "none"; size.style.display = "none"; document.body.classList.remove("drag"); hint.style.display = "block";
      return;
    }
    finish(r);
  });
})();
</script></body></html>`;
}

export function captureOverlayUrl(): string {
  return "data:text/html;charset=utf-8," + encodeURIComponent(captureOverlayHtml());
}
