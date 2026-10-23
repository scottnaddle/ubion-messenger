import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { SavedMessage } from "../../electron/core/saved";
import type { Reminder } from "../../electron/core/reminders";
import type { ScheduledMessage } from "../../electron/core/scheduled-send";
import type { ToastFn } from "../App";
import { Icon } from "./ui";
import { useT } from "../lib/i18n";
import { roomTimeLabel } from "../lib/format";

type Tab = "saved" | "reminders" | "scheduled";

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
  const [scheduled, setScheduled] = useState<ScheduledMessage[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setSaved(null);
    setReminders(null);
    setScheduled(null);
    api().saved.list().then(setSaved).catch(() => setSaved([]));
    api().reminders.list().then(setReminders).catch(() => setReminders([]));
    api().scheduled.list().then(setScheduled).catch(() => setScheduled([]));
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

  const cancelScheduled = async (item: ScheduledMessage) => {
    setBusy(true);
    try {
      await api().scheduled.cancel(item.id);
      setScheduled((l) => (l || []).filter((x) => x.id !== item.id));
      toast(t("예약을 취소했습니다"), "info");
    } catch (e) {
      toast(t("예약을 취소하지 못했습니다: {error}", { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const sendNow = async (item: ScheduledMessage) => {
    setBusy(true);
    try {
      await api().scheduled.sendNow(item.id);
      setScheduled((l) => (l || []).filter((x) => x.id !== item.id));
      toast(t("메시지를 보냈습니다"), "info");
    } catch (e) {
      toast(t("메시지를 보내지 못했습니다: {error}", { error: (e as Error).message }));
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
          <button className={`chip ${tab === "scheduled" ? "on" : ""}`} onClick={() => setTab("scheduled")}>{t("예약 메시지")}</button>
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
          ) : tab === "reminders" ? (
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
          ) : (
            <List empty={scheduled && !scheduled.length ? t("예약 메시지가 없습니다") : undefined}>
              {(scheduled || []).map((item) => (
                <ScheduledRow key={item.id} item={item} busy={busy}
                  onOpen={() => open(item.roomKey)} onSendNow={() => sendNow(item)} onCancel={() => cancelScheduled(item)} />
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

function ScheduledRow({ item, busy, onOpen, onSendNow, onCancel }: {
  item: ScheduledMessage; busy: boolean; onOpen: () => void; onSendNow: () => void; onCancel: () => void;
}) {
  const t = useT();
  return (
    <div className="room" role="button" onClick={onOpen}>
      <div className="room-body">
        <div className="room-name">
          {item.roomName || item.roomKey}
          <span className="muted small"> · {formatDue(item.sendAt)}</span>
          {item.state === "missed" && <span className="muted small"> · {t("놓침")}</span>}
        </div>
        <div className="room-preview">{item.text || t("(내용 없음)")}</div>
      </div>
      {item.state === "missed" && (
        <button className="link small" disabled={busy} onClick={(e) => { e.stopPropagation(); onSendNow(); }}>{t("보내기")}</button>
      )}
      <button
        className="icon-btn"
        title={t("취소")}
        disabled={busy}
        onClick={(e) => { e.stopPropagation(); onCancel(); }}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
