import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type Room } from "../api";
import {
  BACKUP_DEFAULT_FILE_TYPE, BACKUP_DELETE_CONFIRM, BACKUP_POLL_MAX, BACKUP_POLL_MS, HISTORY_CLEAR_CONFIRM,
  backupFileName, backupsForRoom, backupStatusLabel, buildBackupRequest, isBackupDone, shouldPollBackups,
  type BackupFileType, type BackupItem,
} from "../../electron/core/backup";
import { apiRoomSeq } from "../../electron/core/forward";
import type { ToastFn } from "../App";
import { Icon } from "./ui";

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

type Confirm = { kind: "delete"; item: BackupItem } | { kind: "clear" };

export function BackupModal({
  room, lastMessageId, toast, onClose, onHistoryCleared,
}: {
  room: Room; lastMessageId?: number; toast: ToastFn; onClose: () => void; onHistoryCleared?: () => void;
}) {
  const today = ymd(new Date());
  const [from, setFrom] = useState(() => ymd(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(today);
  const [fileType, setFileType] = useState<BackupFileType>(BACKUP_DEFAULT_FILE_TYPE);
  const [items, setItems] = useState<BackupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [clearEnabled, setClearEnabled] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rounds = useRef(0);
  const alive = useRef(true);

  let roomSeq: number | null = null;
  try {
    roomSeq = apiRoomSeq(room);
  } catch {
    roomSeq = null;
  }

  const poll = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (roomSeq == null) return setLoading(false);
    try {
      const list = backupsForRoom(await api().backup.list(), roomSeq);
      if (!alive.current) return;
      setItems(list);
      if (shouldPollBackups(list) && rounds.current++ < BACKUP_POLL_MAX) {
        timer.current = setTimeout(() => void poll(), BACKUP_POLL_MS);
      }
    } catch (e) {
      if (alive.current) toast(`백업 목록을 불러오지 못했습니다: ${(e as Error).message}`);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [roomSeq, toast]);

  useEffect(() => {
    alive.current = true;
    void poll();
    api().backup.config().then((c) => alive.current && setClearEnabled(!!c?.historyClearEnabled)).catch(() => undefined);
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poll]);

  const restartPoll = () => {
    rounds.current = 0;
    void poll();
  };

  const request = async () => {
    try {
      buildBackupRequest(from, to, fileType); // validate before the IPC round trip
    } catch (e) {
      return toast((e as Error).message);
    }
    setBusy(true);
    try {
      await api().backup.request(room.key, from, to, fileType);
      toast("백업을 요청했습니다", "info");
      restartPoll();
    } catch (e) {
      toast(`백업을 요청하지 못했습니다: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const download = async (b: BackupItem) => {
    try {
      const p = await api().backup.download(room.key, b.id, "downloads");
      if (p) toast(`저장했습니다: ${p}`, "info");
    } catch (e) {
      toast(`백업 파일을 저장하지 못했습니다: ${(e as Error).message}`);
    }
  };

  const doConfirm = async () => {
    const c = confirm;
    setConfirm(null);
    if (!c) return;
    setBusy(true);
    try {
      if (c.kind === "delete") {
        await api().backup.remove(room.key, c.item.id);
        toast(isBackupDone(c.item) ? "백업 파일을 삭제했습니다" : "백업을 취소했습니다", "info");
        restartPoll();
      } else {
        if (!lastMessageId) throw new Error("삭제할 대화가 없습니다");
        await api().backup.clearHistory(room.key, lastMessageId, true);
        toast("대화 기록을 삭제했습니다", "info");
        onHistoryCleared?.();
        onClose();
      }
    } catch (e) {
      toast(`${c.kind === "delete" ? "백업 삭제" : "대화 기록 삭제"}에 실패했습니다: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-back" onClick={onClose}>
      <div className="modal backup-modal" role="dialog" aria-modal="true" aria-label="대화 백업" onClick={(e) => e.stopPropagation()}>
        <div className="side-head">
          <h3>대화 백업</h3>
          <button className="icon-btn" title="닫기" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
        {confirm ? (
          <div className="modal-body">
            <p>{confirm.kind === "delete" ? BACKUP_DELETE_CONFIRM : HISTORY_CLEAR_CONFIRM}</p>
            <div className="approval-modal-actions">
              <button className="link" disabled={busy} onClick={() => setConfirm(null)}>취소</button>
              <button className="danger-btn" autoFocus disabled={busy} onClick={() => void doConfirm()}>삭제</button>
            </div>
          </div>
        ) : (
          <div className="modal-body">
            <h4>백업 기간</h4>
            <div className="backup-range">
              <input type="date" aria-label="시작일" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} />
              <span className="muted">~</span>
              <input type="date" aria-label="종료일" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
            </div>
            <h4>파일 형식</h4>
            <div className="chips backup-types">
              {(["TXT", "HTML"] as const).map((t) => (
                <button key={t} className={`chip ${fileType === t ? "on" : ""}`} onClick={() => setFileType(t)}>{t}</button>
              ))}
            </div>
            <div className="approval-modal-actions">
              <button className="primary" disabled={busy || roomSeq == null} onClick={() => void request()}>백업 요청</button>
            </div>
            <h4>백업 파일</h4>
            <div className="backup-list">
              {loading && <div className="muted small">불러오는 중…</div>}
              {!loading && !items.length && <div className="muted small">이 대화방의 백업 파일이 없습니다</div>}
              {items.map((b) => (
                <div key={b.id} className="backup-item">
                  <Icon name="file" size={16} />
                  <div className="backup-item-body">
                    <div className="backup-item-name" title={backupFileName(b)}>{backupFileName(b)}</div>
                    <div className={`muted tiny backup-status ${b.status.toLowerCase()}`}>{backupStatusLabel(b.status)}</div>
                  </div>
                  {isBackupDone(b) && (
                    <button className="icon-btn" title="저장" onClick={() => void download(b)}><Icon name="download" size={16} /></button>
                  )}
                  <button
                    className="icon-btn" title={isBackupDone(b) ? "삭제" : "취소"} disabled={busy}
                    onClick={() => setConfirm({ kind: "delete", item: b })}
                  >
                    <Icon name={isBackupDone(b) ? "trash" : "close"} size={16} />
                  </button>
                </div>
              ))}
            </div>
            {clearEnabled && (
              <div className="backup-clear">
                <h4>대화 기록 삭제</h4>
                <p className="muted small">이 대화방의 지금까지의 대화 기록을 내 화면에서 삭제합니다. (실험 기능)</p>
                <div className="approval-modal-actions">
                  <button className="danger-btn" disabled={busy || !lastMessageId} onClick={() => setConfirm({ kind: "clear" })}>
                    대화 기록 삭제
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
