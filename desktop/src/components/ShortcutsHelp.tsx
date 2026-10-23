import { createPortal } from "react-dom";
import { Icon } from "./ui";
import { useT } from "../lib/i18n";

/** ⌘/Ctrl+/ shortcuts help overlay. */
export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const t = useT();
  const rows: Array<{ keys: string; label: string }> = [
    { keys: "⌘/Ctrl+K", label: t("명령 팔레트") },
    { keys: "⌘/Ctrl+F", label: t("대화방 검색") },
    { keys: "⌘/Ctrl+Shift+F", label: t("전체 대화 검색") },
    { keys: "⌘/Ctrl+Shift+A", label: t("다음 안 읽은 대화") },
    { keys: "⌘/Ctrl+N", label: t("조직도") },
    { keys: "⌘/Ctrl+1..6", label: t("탭 이동") },
    { keys: "Alt+↑/↓", label: t("이전/다음 대화") },
    { keys: "⌘/Ctrl+,", label: t("설정") },
    { keys: "Esc", label: t("닫기") },
  ];
  return createPortal(
    <div className="modal-back" onClick={onClose}>
      <div className="modal shortcuts-help" role="dialog" aria-modal="true" aria-label={t("단축키")} onClick={(e) => e.stopPropagation()}>
        <div className="side-head">
          <h3>{t("단축키")}</h3>
          <button className="icon-btn" title={t("닫기")} onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="modal-body">
          {rows.map((r) => (
            <div key={r.keys} className="shortcut-row">
              <kbd>{r.keys}</kbd>
              <span>{r.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
