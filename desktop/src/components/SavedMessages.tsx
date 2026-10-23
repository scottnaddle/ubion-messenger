import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { SavedMessage } from "../../electron/core/saved";
import type { Reminder } from "../../electron/core/reminders";
import type { ToastFn } from "../App";
import { Icon } from "./ui";
import { useT } from "../lib/i18n";
import { roomTimeLabel } from "../lib/format";

type Tab = "saved" | "reminders";

function formatDue(dueAt: number): string {
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("ko-KR", { month: "long", day: "numeric" }) + " " +
    d.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
}

/** 저장한 메시지 + 나중에 알림 목록 (client-local). Clicking an item opens the room. */
export function SavedMessages({ toast, onOpenRoom, onClose }: {
  toast: ToastFn; onOpenRoom: (key: string) => void; onClose: () => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("saved");
  const [saved, setSaved] = useState<SavedMessage[] | null>(null);
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setSaved(null);
    setReminders(null);
    api().saved.list().then(setSaved).catch(() => setSaved([]));
    api().reminders.list().then(setReminders).catch(() => setReminders([]));
  }, []);
  useEffect(() => load(), [load]);

  const removeSaved = async (item: SavedMessage) => {
    setBusy(true);
    try {
      await api().saved.remove(item.id);
      setSaved((l) => (l || []).filter((x) => x.id !== item.id));
      toast(t("저장한 메시지를 삭제했습니다"), "info");
    } catch (e) {
      toast(t("삭제하지 못했습니다: {error}", { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const removeReminder = async (item: Reminder) => {
    setBusy(true);
    try {
      await api().reminders.remove(item.id);
      setReminders((l) => (l || []).filter((x) => x.id !== item.id));
      toast(t("알림을 삭제했습니다"), "info");
    } catch (e) {
      toast(t("삭제하지 못했습니다: {error}", { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const open = (key: string) => {
    onClose();
    onOpenRoom(key);
  };

  return createPortal(
    <div className="modal-back" onClick={onClose}>
      <div className="modal pubsub-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="side-head">
          <h3>{t("저장한 메시지")}</h3>
          <button className="icon-btn" title={t("닫기")} onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="chips" style={{ paddingTop: 8 }}>
          <button className={`chip ${tab === "saved" ? "on" : ""}`} onClick={() => setTab("saved")}>{t("저장한 메시지")}</button>
          <button className={`chip ${tab === "reminders" ? "on" : ""}`} onClick={() => setTab("reminders")}>{t("나중에 알림")}</button>
        </div>
        <div className="modal-body">
          {tab === "saved" ? (
            <List empty={saved && !saved.length ? t("저장한 메시지가 없습니다") : undefined}>
              {(saved || []).map((item) => (
                <Row key={item.id} onClick={() => open(item.roomKey)} onRemove={() => removeSaved(item)} busy={busy}>
                  <div className="room-name">{item.roomName || item.roomKey}</div>
                  <div className="room-preview">{item.message || t("(내용 없음)")}</div>
                  <div className="muted tiny">
                    {item.sendUserName}{item.createdAt ? ` · ${roomTimeLabel(item.createdAt)}` : ""}
                  </div>
                </Row>
              ))}
            </List>
          ) : (
            <List empty={reminders && !reminders.length ? t("알림이 없습니다") : undefined}>
              {(reminders || []).map((item) => (
                <Row key={item.id} onClick={() => open(item.roomKey)} onRemove={() => removeReminder(item)} busy={busy}>
                  <div className="room-name">
                    {item.roomName || item.roomKey} <span className="muted small">· {formatDue(item.dueAt)}</span>
                  </div>
                  <div className="room-preview">{item.message || t("(내용 없음)")}</div>
                </Row>
              ))}
            </List>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function List({ empty, children }: { empty?: string; children: ReactNode }) {
  const t = useT();
  const list = Array.isArray(children) ? children : [];
  if (empty) return <div className="empty-list muted">{empty}</div>;
  if (!list.length) return <div className="muted small pad">{t("불러오는 중…")}</div>;
  return <div className="room-list pubsub-list">{children}</div>;
}

function Row({ onClick, onRemove, busy, children }: {
  onClick: () => void; onRemove: () => void; busy: boolean; children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="room" role="button" onClick={onClick}>
      <div className="room-body">{children}</div>
      <button
        className="icon-btn"
        title={t("삭제")}
        disabled={busy}
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
      >
        <Icon name="trash" size={14} />
      </button>
    </div>
  );
}
