import { useEffect, useRef, useState } from "react";
import { api, media, type ChatMessage } from "../api";
import { attachKind, durationLabel, expiryLabel, fileIcon, isExpired, sizeLabel } from "../../electron/core/attach";
import { Icon } from "./ui";

export const fileUrl = (cryptId: string, messageId?: number) =>
  messageId != null ? media(`/api/chat/files/${encodeURIComponent(cryptId)}?messageId=${messageId}`) : "";

type SaveMode = "downloads" | "saveAs" | "open";

/** DaouOffice-style attachment bubble: image/video thumbnails or a file card with 저장 / 다른 이름으로 저장. */
export function FileCard({
  m, mine, onOpenMedia, toast,
}: { m: ChatMessage; mine: boolean; onOpenMedia: () => void; toast: (t: string) => void }) {
  const a = m.attach!;
  const missing = !a.cryptId && !a.expired;
  const expired = missing || isExpired(a);
  const kind = attachKind(a);
  const exp = expiryLabel(a);
  const save = async (mode: SaveMode) => {
    if (expired || m.messageId == null) return;
    try {
      const p = await api().call<string | null>("files:save", a.cryptId, m.messageId, a.name, mode);
      if (p && mode === "downloads") toast(`다운로드 폴더에 저장했습니다`);
    } catch (e) {
      toast(`다운로드 실패: ${(e as Error).message}`);
    }
  };
  const actions = (
    <div className="fc-actions">
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
      <div className="media-card">
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
      <div className="media-card">
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
    <div className={`file-card ${mine ? "mine" : ""} ${expired ? "expired" : ""}`} aria-disabled={expired}>
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
export function MediaViewer({ m, onClose, toast }: { m: ChatMessage; onClose: () => void; toast: (t: string) => void }) {
  const a = m.attach!;
  const kind = attachKind(a);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  const src = fileUrl(a.cryptId, m.messageId);
  const save = (mode: SaveMode) => api().call("files:save", a.cryptId, m.messageId, a.name, mode).catch((e) => toast((e as Error).message));
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
