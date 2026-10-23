import { useEffect, useRef, useState } from "react";
import { api, media, type ChatMessage } from "../api";
import { attachKind, durationLabel, expiryLabel, fileIcon, isExpired, sizeLabel } from "../../electron/core/attach";
import { isPreviewExtension } from "../../electron/core/doc-preview";
import { Icon } from "./ui";
import { ForwardModal } from "./ForwardModal";

export const fileUrl = (cryptId: string, messageId?: number) =>
  messageId != null ? media(`/api/chat/files/${encodeURIComponent(cryptId)}?messageId=${messageId}`) : "";

type SaveMode = "downloads" | "saveAs" | "open";
type ToastFn = (text: string, kind?: "error" | "info", action?: { label: string; run: () => void }) => void;

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const dirName = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))) || p;

/** One path for every chat file save (cards, context menu, viewer). Uses main's files:save. */
export async function saveChatFile(m: ChatMessage, mode: SaveMode, toast: ToastFn): Promise<string | null> {
  const a = m.attach;
  if (!a?.cryptId || m.messageId == null) return null;
  try {
    const p = await api().call<string | null>("files:save", a.cryptId, m.messageId, a.name, mode);
    if (p && mode !== "open")
      toast(`${baseName(p)} 저장됨 · ${dirName(p)}`, "info", { label: "폴더 열기", run: () => void api().call("files:showInFolder", p) });
    return p;
  } catch (e) {
    toast(`다운로드 실패: ${(e as Error).message}`);
    return null;
  }
}

/** Right-click menu for a file card: 저장 / 다른 이름으로 저장 / 삭제. */
function SaveMenu({
  x, y, onPick, onDelete, onForward, onNotice, canSave = true, canForward = false, canNotice = false, onClose,
}: {
  x: number; y: number; onPick: (m: SaveMode) => void; onDelete?: () => void;
  onForward?: () => void; onNotice?: () => void; canSave?: boolean; canForward?: boolean; canNotice?: boolean; onClose: () => void;
}) {
  useEffect(() => {
    const h = (e: Event) => { if (e instanceof KeyboardEvent && e.key !== "Escape") return; onClose(); };
    window.addEventListener("mousedown", h); window.addEventListener("keydown", h); window.addEventListener("blur", h);
    return () => { window.removeEventListener("mousedown", h); window.removeEventListener("keydown", h); window.removeEventListener("blur", h); };
  }, [onClose]);
  return (
    <div className="ctx-menu" role="menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      {canSave && <>
        <button role="menuitem" onClick={() => { onClose(); onPick("downloads"); }}><Icon name="download" size={14} /> 저장</button>
        <button role="menuitem" onClick={() => { onClose(); onPick("saveAs"); }}>다른 이름으로 저장…</button>
        <button role="menuitem" onClick={() => { onClose(); onPick("open"); }}><Icon name="external" size={14} /> 기본 앱으로 열기</button>
      </>}
      {onForward && canForward && <button role="menuitem" onClick={() => { onClose(); onForward(); }}><Icon name="send" size={14} /> 전달</button>}
      {onNotice && canNotice && <button role="menuitem" onClick={() => { onClose(); onNotice(); }}><Icon name="report" size={14} /> 공지로 등록</button>}
      {onDelete && <button role="menuitem" className="danger" onClick={() => { onClose(); onDelete(); }}><Icon name="trash" size={14} /> 삭제</button>}
    </div>
  );
}

/** DaouOffice-style attachment bubble: image/video thumbnails or a file card with 저장 / 다른 이름으로 저장. */
export function FileCard({
  m, mine, onOpenMedia, toast, canDelete, onDelete, canNotice, onNotice,
}: {
  m: ChatMessage; mine: boolean; onOpenMedia: () => void; toast: ToastFn;
  canDelete?: boolean; onDelete?: () => void; canNotice?: boolean; onNotice?: () => void;
}) {
  const a = m.attach!;
  const missing = !a.cryptId && !a.expired;
  const expired = missing || isExpired(a);
  const kind = attachKind(a);
  const exp = expiryLabel(a);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [forwardOpen, setForwardOpen] = useState(false);
  const save = async (mode: SaveMode) => { if (!expired) await saveChatFile(m, mode, toast); };
  const ctxDelete = canDelete && onDelete ? onDelete : undefined;
  const ctxNotice = canNotice && onNotice ? onNotice : undefined;
  const canForward = !expired && !!a.cryptId;
  const onCtx = (e: React.MouseEvent) => {
    if (expired && !ctxDelete && !ctxNotice) return;
    e.preventDefault();
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 200), y: Math.min(e.clientY, window.innerHeight - 190) });
  };
  const forwardModal = forwardOpen ? <ForwardModal m={m} toast={toast} onClose={() => setForwardOpen(false)} /> : null;
  const ctx = menu && (
    <SaveMenu
      x={menu.x} y={menu.y} onPick={(md) => void save(md)} onDelete={ctxDelete}
      canSave={!expired} canForward={canForward} onForward={() => setForwardOpen(true)}
      canNotice={!!ctxNotice} onNotice={ctxNotice} onClose={() => setMenu(null)}
    />
  );
  const canPreview = !expired && !!a.cryptId && m.messageId != null && kind === "file" && isPreviewExtension(a.name, a.extention);
  const [previewing, setPreviewing] = useState(false);
  const preview = async () => {
    if (!canPreview || previewing) return;
    setPreviewing(true);
    try {
      await api().previewFile(a.cryptId, m.messageId!, a.name, a.extention);
    } catch (e) {
      toast(`미리보기 실패: ${(e as Error).message}`);
    } finally {
      setPreviewing(false);
    }
  };
  const actions = (
    <div className="fc-actions">
      {canPreview && <>
        <button className="link tiny" disabled={previewing} onClick={() => void preview()}>{previewing ? "여는 중…" : "미리보기"}</button>
        <span className="fc-sep">|</span>
      </>}
      <button className="link tiny" disabled={expired} onClick={() => save("downloads")}>저장</button>
      <span className="fc-sep">|</span>
      <button className="link tiny" disabled={expired} onClick={() => save("saveAs")}>다른 이름으로 저장</button>
    </div>
  );
  const meta = (
    <div className="fc-meta tiny">
      {exp && <span>{exp}</span>}
      {a.size != null && <span>{sizeLabel(a.size)}</span>}
    </div>
  );

  if (!expired && kind === "image") {
    return (
      <div className="media-card" onContextMenu={onCtx}>
        {ctx}{forwardModal}
        <button className="img-bubble" onClick={onOpenMedia} title={a.name}>
          <LazyImg src={media(a.thumbMid || a.thumbLarge || a.thumbSmall) || fileUrl(a.cryptId, m.messageId)} alt={a.name} w={a.width} h={a.height} />
        </button>
        {meta}
        {actions}
      </div>
    );
  }
  if (!expired && kind === "video") {
    const poster = media(a.videoThumb || a.thumbMid || a.thumbLarge || a.thumbSmall);
    return (
      <div className="media-card" onContextMenu={onCtx}>
        {ctx}{forwardModal}
        <button className="img-bubble video-bubble" onClick={onOpenMedia} title={a.name}>
          {poster ? <LazyImg src={poster} alt={a.name} w={a.width} h={a.height} /> : <VideoFrame src={fileUrl(a.cryptId, m.messageId)} size={a.size} />}
          <span className="play-ic" aria-hidden>▶</span>
          {durationLabel(a.duration) && <span className="dur">{durationLabel(a.duration)}</span>}
        </button>
        <div className="fc-name tiny" title={a.name}>{a.name}</div>
        {meta}
        {actions}
      </div>
    );
  }
  const ic = fileIcon(a.name, a.extention);
  return (
    <div className={`file-card ${mine ? "mine" : ""} ${expired ? "expired" : ""}`} aria-disabled={expired} onContextMenu={onCtx}>
      {ctx}{forwardModal}
      <div className="fc-top">
        <button className="fc-dl" disabled={expired} title={expired ? "만료된 파일" : "저장"} onClick={() => save("downloads")}>
          <Icon name="download" size={20} />
        </button>
        <div className="fc-body">
          <div className="fc-title" title={a.name}>
            <span className="fc-badge" style={{ background: ic.color }}>{ic.label}</span>
            <span className="fc-fname">{a.name}</span>
          </div>
          {meta}
          {expired && <div className="fc-expired tiny">{missing ? "파일 정보를 불러올 수 없습니다" : "기간이 만료되어 다운로드할 수 없습니다"}</div>}
        </div>
      </div>
      {!expired && actions}
    </div>
  );
}

/** Keeps aspect ratio, max ~240px, lazy-loaded; falls back to an icon on error. */
function LazyImg({ src, alt, w, h }: { src: string; alt: string; w?: number; h?: number }) {
  const [err, setErr] = useState(false);
  if (err || !src) return <div className="thumb-fallback"><Icon name="image" size={28} /></div>;
  const style = w && h ? { aspectRatio: `${w} / ${h}` } : undefined;
  return <img className="thumb" src={src} alt={alt} loading="lazy" decoding="async" style={style} onError={() => setErr(true)} />;
}

const FRAME_MAX_BYTES = 30 * 1024 * 1024;
/** No server poster: grab the first frame in a hidden <video> once visible (skipped for big files). */
function VideoFrame({ src, size }: { src: string; size?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [poster, setPoster] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const allowed = !!src && (size == null || size <= FRAME_MAX_BYTES);
  useEffect(() => {
    if (!allowed || !ref.current) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (setVisible(true), io.disconnect()));
    io.observe(ref.current);
    return () => io.disconnect();
  }, [allowed]);
  useEffect(() => {
    if (!visible) return;
    const v = document.createElement("video");
    v.muted = true; v.preload = "metadata"; v.src = src;
    const onData = () => { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); };
    const onSeek = () => {
      try {
        const c = document.createElement("canvas");
        const k = Math.min(1, 480 / (v.videoWidth || 480));
        c.width = Math.round((v.videoWidth || 320) * k); c.height = Math.round((v.videoHeight || 180) * k);
        c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
        setPoster(c.toDataURL("image/jpeg", 0.75));
      } catch { /* ignore */ }
      v.removeAttribute("src"); v.load();
    };
    v.addEventListener("loadeddata", onData, { once: true });
    v.addEventListener("seeked", onSeek, { once: true });
    return () => { v.removeAttribute("src"); v.load(); };
  }, [visible, src]);
  return (
    <div ref={ref} className="video-frame">
      {poster ? <img className="thumb" src={poster} alt="" /> : <div className="thumb-fallback"><Icon name="file" size={28} /></div>}
    </div>
  );
}

/** Full-screen viewer for images and in-app video player. */
export function MediaViewer({ m, onClose, toast }: { m: ChatMessage; onClose: () => void; toast: ToastFn }) {
  const a = m.attach!;
  const kind = attachKind(a);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  const src = fileUrl(a.cryptId, m.messageId);
  const save = (mode: SaveMode) => void saveChatFile(m, mode, toast);
  return (
    <div className="viewer" onClick={onClose}>
      <div className="viewer-bar" onClick={(e) => e.stopPropagation()}>
        <span className="file-name">{a.name}</span>
        <span className="muted tiny">{sizeLabel(a.size)}</span>
        <div className="grow" />
        <button className="link tiny" onClick={() => save("downloads")}>저장</button>
        <button className="link tiny" onClick={() => save("saveAs")}>다른 이름으로 저장</button>
        <button className="icon-btn" title="기본 앱으로 열기" onClick={() => save("open")}><Icon name="external" /></button>
        <button className="icon-btn" title="닫기 (Esc)" onClick={onClose}><Icon name="close" /></button>
      </div>
      {kind === "video" ? (
        <video className="viewer-img" src={src} controls autoPlay poster={media(a.videoThumb || a.thumbLarge) || undefined}
          onClick={(e) => e.stopPropagation()} onError={() => toast("앱 안에서 재생할 수 없는 형식입니다. '기본 앱으로 열기'를 사용하세요.")} />
      ) : (
        <img
          className="viewer-img"
          src={media(a.thumbOriginal || a.thumbLarge) || src}
          onError={(e) => { if (src && (e.target as HTMLImageElement).src !== src) (e.target as HTMLImageElement).src = src; }}
          onClick={(e) => e.stopPropagation()}
          alt={a.name}
        />
      )}
    </div>
  );
}
