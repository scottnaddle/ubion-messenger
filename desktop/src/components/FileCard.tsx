import { useEffect, useState } from "react";
import { api, media, type ChatMessage } from "../api";
import { attachKind, durationLabel, expiryLabel, fileIcon, isExpired, sizeLabel } from "../../electron/core/attach";
import { chatFileMediaPath } from "../../electron/core/media-response";
import { isPreviewExtension } from "../../electron/core/doc-preview";
import { Icon } from "./ui";
import { t as tr, tk, useT } from "../lib/i18n";
import { claimPlaybackError, playbackErrorKey } from "../lib/playback-error";
import { ForwardModal } from "./ForwardModal";
import { isMobileUi } from "../lib/compact";

export const fileUrl = (cryptId: string, messageId?: number, nameOrExt?: string) =>
  messageId != null ? media(chatFileMediaPath(cryptId, messageId, nameOrExt)) : "";

/**
 * Desktop already has an authenticated URL (ubion-media://). Capacitor does not, so chat
 * images and video are fetched with the session cookie and played from a blob: URL.
 */
function useAuthenticatedSrc(raw: string): { src: string; pending: boolean; failed: boolean } {
  const mobile = typeof __UBM_MOBILE__ !== "undefined" && __UBM_MOBILE__;
  const [state, setState] = useState(() => ({ src: mobile ? "" : raw, pending: mobile && !!raw, failed: false }));
  useEffect(() => {
    if (!mobile) {
      setState({ src: raw, pending: false, failed: false });
      return;
    }
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) {
      setState({ src: raw, pending: false, failed: false });
      return;
    }
    let cancel = false;
    setState({ src: "", pending: true, failed: false });
    api().call<string>("media:url", raw).then((u) => {
      if (!cancel) setState({ src: u || "", pending: false, failed: !u });
    }).catch(() => {
      if (!cancel) setState({ src: "", pending: false, failed: true });
    });
    return () => { cancel = true; };
  }, [mobile, raw]);
  return state;
}

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
      toast(tr("{name} 저장됨 · {dir}", { name: baseName(p), dir: dirName(p) }), "info", {
        label: isMobileUi() ? tr(tk("공유")) : tr("폴더 열기"),
        run: () => void api().call("files:showInFolder", p),
      });
    return p;
  } catch (e) {
    toast(tr("다운로드 실패: {error}", { error: (e as Error).message }));
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
  const t = useT();
  useEffect(() => {
    const h = (e: Event) => { if (e instanceof KeyboardEvent && e.key !== "Escape") return; onClose(); };
    window.addEventListener("mousedown", h); window.addEventListener("keydown", h); window.addEventListener("blur", h);
    return () => { window.removeEventListener("mousedown", h); window.removeEventListener("keydown", h); window.removeEventListener("blur", h); };
  }, [onClose]);
  const sheet = isMobileUi();
  return sheet ? (
    <div className="sheet-back" onMouseDown={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="ctx-menu sheet" role="menu" onMouseDown={(e) => e.stopPropagation()}>
        {canSave && <>
          <button role="menuitem" onClick={() => { onClose(); onPick("downloads"); }}><Icon name="download" size={14} /> {t("저장")}</button>
          <button role="menuitem" onClick={() => { onClose(); onPick("saveAs"); }}>{t("다른 이름으로 저장…")}</button>
          <button role="menuitem" onClick={() => { onClose(); onPick("open"); }}><Icon name="external" size={14} /> {t("공유 / 다른 앱으로 열기")}</button>
        </>}
        {onForward && canForward && <button role="menuitem" onClick={() => { onClose(); onForward(); }}><Icon name="send" size={14} /> {t("전달")}</button>}
        {onNotice && canNotice && <button role="menuitem" onClick={() => { onClose(); onNotice(); }}><Icon name="report" size={14} /> {t("공지로 등록")}</button>}
        {onDelete && <button role="menuitem" className="danger" onClick={() => { onClose(); onDelete(); }}><Icon name="trash" size={14} /> {t("삭제")}</button>}
        <button role="menuitem" onClick={onClose}>{t("취소")}</button>
      </div>
    </div>
  ) : (
    <div className="ctx-menu" role="menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      {canSave && <>
        <button role="menuitem" onClick={() => { onClose(); onPick("downloads"); }}><Icon name="download" size={14} /> {t("저장")}</button>
        <button role="menuitem" onClick={() => { onClose(); onPick("saveAs"); }}>{t("다른 이름으로 저장…")}</button>
        <button role="menuitem" onClick={() => { onClose(); onPick("open"); }}><Icon name="external" size={14} /> {t("기본 앱으로 열기")}</button>
      </>}
      {onForward && canForward && <button role="menuitem" onClick={() => { onClose(); onForward(); }}><Icon name="send" size={14} /> {t("전달")}</button>}
      {onNotice && canNotice && <button role="menuitem" onClick={() => { onClose(); onNotice(); }}><Icon name="report" size={14} /> {t("공지로 등록")}</button>}
      {onDelete && <button role="menuitem" className="danger" onClick={() => { onClose(); onDelete(); }}><Icon name="trash" size={14} /> {t("삭제")}</button>}
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
  const t = useT();
  const unplayableText = t("앱 안에서 재생할 수 없는 형식입니다. '기본 앱으로 열기'를 사용하세요.");
  const a = m.attach!;
  const missing = !a.cryptId && !a.expired;
  const expired = missing || isExpired(a);
  const kind = attachKind(a);
  const exp = expiryLabel(a);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [unplayable, setUnplayable] = useState(false);
  const videoPath = !expired && kind === "video" ? fileUrl(a.cryptId, m.messageId, a.extention || a.name) : "";
  const posterPath = !expired && kind === "video" ? media(a.videoThumb || a.thumbMid || a.thumbLarge || a.thumbSmall) : "";
  const playable = useAuthenticatedSrc(videoPath);
  const poster = useAuthenticatedSrc(posterPath);
  const onPlayError = () => {
    setUnplayable(true);
    if (claimPlaybackError(playbackErrorKey(a.cryptId, m.messageId))) toast(unplayableText);
  };
  useEffect(() => {
    if (playable.failed) onPlayError();
    // toast identity changes every render; the failed flag is the signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playable.failed]);
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
  const canPreview = !isMobileUi() && !expired && !!a.cryptId && m.messageId != null && kind === "file" && isPreviewExtension(a.name, a.extention);
  const [previewing, setPreviewing] = useState(false);
  const preview = async () => {
    if (!canPreview || previewing) return;
    setPreviewing(true);
    try {
      await api().previewFile(a.cryptId, m.messageId!, a.name, a.extention);
    } catch (e) {
      toast(t("미리보기 실패: {error}", { error: (e as Error).message }));
    } finally {
      setPreviewing(false);
    }
  };
  const actions = (
    <div className="fc-actions">
      {canPreview && <>
        <button className="link tiny" disabled={previewing} onClick={() => void preview()}>{previewing ? t("여는 중…") : t("미리보기")}</button>
        <span className="fc-sep">|</span>
      </>}
      <button className="link tiny" disabled={expired} onClick={() => save("downloads")}>{t("저장")}</button>
      <span className="fc-sep">|</span>
      <button className="link tiny" disabled={expired} onClick={() => save("saveAs")}>{t("다른 이름으로 저장")}</button>
    </div>
  );
  const meta = (
    <div className="fc-meta tiny">
      {exp && <span>{t(exp)}</span>}
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
    const showFallback = unplayable || playable.failed || (!playable.pending && !playable.src);
    return (
      <div className="media-card" onContextMenu={onCtx}>
        {ctx}{forwardModal}
        {playable.pending ? (
          <div className="inline-video video-pending" role="status">{t("불러오는 중…")}</div>
        ) : showFallback ? (
          <div className="video-fallback">
            {poster.src ? <img src={poster.src} alt="" /> : null}
            <p className="tiny">{unplayableText}</p>
            <button className="link tiny" type="button" onClick={() => void save("open")}>{isMobileUi() ? t("공유 / 다른 앱으로 열기") : t("기본 앱으로 열기")}</button>
          </div>
        ) : (
          <video
            className="inline-video"
            src={playable.src}
            poster={poster.src || undefined}
            controls
            playsInline
            preload="metadata"
            aria-label={a.name}
            onError={onPlayError}
          />
        )}
        <div className="fc-name tiny" title={a.name}>{a.name}</div>
        {durationLabel(a.duration) && <div className="fc-meta tiny"><span>{durationLabel(a.duration)}</span></div>}
        {meta}
        {actions}
        <button className="link tiny" type="button" onClick={onOpenMedia}>{t("크게 보기")}</button>
      </div>
    );
  }
  const ic = fileIcon(a.name, a.extention);
  return (
    <div className={`file-card ${mine ? "mine" : ""} ${expired ? "expired" : ""}`} aria-disabled={expired} onContextMenu={onCtx}>
      {ctx}{forwardModal}
      <div className="fc-top">
        <button className="fc-dl" disabled={expired} title={expired ? t("만료된 파일") : t("저장")} onClick={() => save("downloads")}>
          <Icon name="download" size={20} />
        </button>
        <div className="fc-body">
          <div className="fc-title" title={a.name}>
            <span className="fc-badge" style={{ background: ic.color }}>{ic.label}</span>
            <span className="fc-fname">{a.name}</span>
          </div>
          {meta}
          {expired && <div className="fc-expired tiny">{missing ? t("파일 정보를 불러올 수 없습니다") : t("기간이 만료되어 다운로드할 수 없습니다")}</div>}
        </div>
      </div>
      {!expired && actions}
    </div>
  );
}

/** Keeps aspect ratio, max ~240px, lazy-loaded; falls back to an icon on error. */
function LazyImg({ src, alt, w, h }: { src: string; alt: string; w?: number; h?: number }) {
  const [err, setErr] = useState(false);
  const resolved = useAuthenticatedSrc(src);
  const url = err ? "" : resolved.src;
  if (resolved.pending) return <div className="thumb-fallback">{tr("불러오는 중…")}</div>;
  if (err || !url) return <div className="thumb-fallback"><Icon name="image" size={28} /></div>;
  const style = w && h ? { aspectRatio: `${w} / ${h}` } : undefined;
  return <img className="thumb" src={url} alt={alt} loading="lazy" decoding="async" style={style} onError={() => setErr(true)} />;
}

/** Full-screen viewer for images and in-app video player. */
export function MediaViewer({ m, onClose, toast }: { m: ChatMessage; onClose: () => void; toast: ToastFn }) {
  const t = useT();
  const unplayableText = t("앱 안에서 재생할 수 없는 형식입니다. '기본 앱으로 열기'를 사용하세요.");
  const a = m.attach!;
  const kind = attachKind(a);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  const src = useAuthenticatedSrc(fileUrl(a.cryptId, m.messageId, a.extention || a.name));
  const poster = useAuthenticatedSrc(media(a.videoThumb || a.thumbLarge));
  const image = useAuthenticatedSrc(media(a.thumbOriginal || a.thumbLarge) || fileUrl(a.cryptId, m.messageId, a.extention || a.name));
  const save = (mode: SaveMode) => void saveChatFile(m, mode, toast);
  const [unplayable, setUnplayable] = useState(false);
  const onPlayError = () => {
    setUnplayable(true);
    if (claimPlaybackError(playbackErrorKey(a.cryptId, m.messageId))) toast(unplayableText);
  };
  useEffect(() => {
    if (kind === "video" && src.failed) onPlayError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src.failed, kind]);
  return (
    <div className="viewer" onClick={onClose}>
      <div className="viewer-bar" onClick={(e) => e.stopPropagation()}>
        <span className="file-name">{a.name}</span>
        <span className="muted tiny">{sizeLabel(a.size)}</span>
        <div className="grow" />
        <button className="link tiny" onClick={() => save("downloads")}>{t("저장")}</button>
        <button className="link tiny" onClick={() => save("saveAs")}>{t("다른 이름으로 저장")}</button>
        <button className="icon-btn" title={isMobileUi() ? t("공유 / 다른 앱으로 열기") : t("기본 앱으로 열기")} onClick={() => save("open")}><Icon name="external" /></button>
        <button className="icon-btn" title={t("닫기 (Esc)")} onClick={onClose}><Icon name="close" /></button>
      </div>
      {kind === "video" ? (
        src.pending ? (
          <div className="viewer-fallback" onClick={(e) => e.stopPropagation()}>{t("불러오는 중…")}</div>
        ) : unplayable || src.failed || !src.src ? (
          <div className="viewer-fallback" onClick={(e) => e.stopPropagation()}>{unplayableText}</div>
        ) : (
          <video className="viewer-img" src={src.src} controls autoPlay playsInline poster={poster.src || undefined}
            onClick={(e) => e.stopPropagation()} onError={onPlayError} />
        )
      ) : (
        <img
          className="viewer-img"
          src={image.src || src.src}
          onError={(e) => { if (src.src && (e.target as HTMLImageElement).src !== src.src) (e.target as HTMLImageElement).src = src.src; }}
          onClick={(e) => e.stopPropagation()}
          alt={a.name}
        />
      )}
    </div>
  );
}
