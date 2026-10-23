import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api, type Person, type SessionUser } from "../api";
import {
  PUBSUB_DELETE_CONFIRM, PUBSUB_MAX_MESSAGE, PUBSUB_MAX_TARGETS, PUBSUB_PAGE_SIZE,
  type PubsubCaps, type PubsubDetail, type PubsubPage, type PubsubTarget,
} from "../../electron/core/pubsub";
import type { ToastFn } from "../App";
import { Avatar, Icon } from "./ui";

type Tab = "sent" | "compose";

function day(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("ko-KR");
}

export function PubsubModal({ toast, onClose }: { toast: ToastFn; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("sent");
  const [caps, setCaps] = useState<PubsubCaps | null>(null);
  const [me, setMe] = useState<SessionUser | null>(null);

  useEffect(() => {
    api().pubsub.caps().then(setCaps).catch(() => setCaps({ send: false, delete: false, selfOnly: true }));
    api().call<{ user: SessionUser | null }>("auth:state").then((s) => setMe(s?.user ?? null)).catch(() => undefined);
  }, []);

  return createPortal(
    <div className="modal-back" onClick={onClose}>
      <div
        className="modal pubsub-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        <div className="side-head">
          <h3>공지톡</h3>
          <button className="icon-btn" title="닫기" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="chips" style={{ paddingTop: 8 }}>
          <button className={`chip ${tab === "sent" ? "on" : ""}`} onClick={() => setTab("sent")}>보낸 공지톡</button>
          <button className={`chip ${tab === "compose" ? "on" : ""}`} onClick={() => setTab("compose")}>새 공지톡</button>
        </div>
        {tab === "sent" ? (
          <SentList caps={caps} toast={toast} />
        ) : (
          <Composer caps={caps} me={me} toast={toast} onSent={() => setTab("sent")} />
        )}
      </div>
    </div>,
    document.body
  );
}

function SentList({ caps, toast }: { caps: PubsubCaps | null; toast: ToastFn }) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<PubsubPage | null>(null);
  const [err, setErr] = useState("");
  const [detail, setDetail] = useState<PubsubDetail | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback((p: number) => {
    setErr("");
    api().pubsub.list(p).then((r) => { setData(r); setPage(p); }).catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(() => load(0), [load]);

  const open = (id: number) =>
    api().pubsub.detail(id).then(setDetail).catch((e) => toast(`공지톡을 불러오지 못했습니다: ${(e as Error).message}`));

  const remove = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await api().pubsub.remove(detail.id);
      toast("공지톡을 삭제했습니다", "info");
      setDetail(null);
      setConfirmDelete(false);
      load(0);
    } catch (e) {
      toast(`삭제하지 못했습니다: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (detail) {
    return (
      <div className="modal-body pubsub-detail">
        <button className="link" onClick={() => { setDetail(null); setConfirmDelete(false); }}>← 목록</button>
        <div className="muted small">
          {day(detail.createdAt)} · {detail.companyTarget ? "전체사용자" : "특정사용자"} · 확인 {detail.confirmCount}/{detail.recipientCount}
        </div>
        <div className="pubsub-message">{detail.message}</div>
        {detail.nodes.length > 0 && (
          <div className="pubsub-targets">
            {detail.nodes.map((n) => <span key={`${n.nodeType}:${n.nodeId}`} className="tag">{n.nodeValue || n.nodeId}</span>)}
          </div>
        )}
        <div className="approval-modal-actions">
          {confirmDelete ? (
            <>
              <span className="muted small">{PUBSUB_DELETE_CONFIRM}</span>
              <div className="grow" />
              <button className="link" disabled={busy} onClick={() => setConfirmDelete(false)}>취소</button>
              <button className="danger-btn" disabled={busy} onClick={() => void remove()}>삭제</button>
            </>
          ) : (
            <>
              <div className="grow" />
              <button
                className="link"
                disabled={!caps?.delete}
                title={caps?.delete ? "공지톡 삭제" : caps?.reason}
                onClick={() => setConfirmDelete(true)}
              >
                삭제
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / PUBSUB_PAGE_SIZE)) : 1;
  return (
    <div className="modal-body">
      {err && <div className="muted small">{err}</div>}
      {!data && !err && <div className="muted small pad">불러오는 중…</div>}
      {data && !data.items.length && <div className="empty-list muted">보낸 공지톡이 없습니다</div>}
      {data && data.items.length > 0 && (
        <div className="room-list pubsub-list">
          {data.items.map((it) => (
            <div key={it.id} className="room" role="button" onClick={() => void open(it.id)}>
              <div className="room-body">
                <div className="room-name pubsub-subject">{it.message}</div>
                <div className="room-preview">
                  {day(it.createdAt)} · {it.companyTarget ? "전체사용자" : "특정사용자"} · 확인 {it.confirmCount}/{it.recipientCount}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {data && data.total > PUBSUB_PAGE_SIZE && (
        <div className="approval-modal-actions">
          <button className="link" disabled={page <= 0} onClick={() => load(page - 1)}>이전</button>
          <span className="muted small">{page + 1} / {pages}</span>
          <button className="link" disabled={!data.hasMore} onClick={() => load(page + 1)}>다음</button>
        </div>
      )}
    </div>
  );
}

function Composer({
  caps, me, toast, onSent,
}: { caps: PubsubCaps | null; me: SessionUser | null; toast: ToastFn; onSent: () => void }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [message, setMessage] = useState("");
  const [picked, setPicked] = useState<PubsubTarget[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api().call<Person[]>("org:users")
      .then((p) => alive && setPeople(Array.isArray(p) ? p : []))
      .catch((e) => toast((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [toast]);

  const query = q.trim().toLowerCase();
  const shown = useMemo(
    () => people.filter((p) => !query || [p.name, p.position, p.email].some((x) => x.toLowerCase().includes(query))),
    [people, query]
  );
  const isPicked = (id: number) => picked.some((t) => t.userId === id);
  const toggle = (id: number, name: string) => {
    setPicked((prev) => {
      if (prev.some((t) => t.userId === id)) return prev.filter((t) => t.userId !== id);
      if (prev.length >= PUBSUB_MAX_TARGETS) {
        toast(`한 번에 최대 ${PUBSUB_MAX_TARGETS}명까지 보낼 수 있습니다`);
        return prev;
      }
      return [...prev, { userId: id, name }];
    });
  };

  const canSend = !!caps?.send;
  const request = () => {
    if (!canSend) return;
    if (!message.trim()) return toast("공지톡 내용을 입력하세요");
    if (!picked.length) return toast("공지톡을 받을 대상을 선택하세요");
    setConfirm(true);
  };

  const send = async () => {
    setBusy(true);
    try {
      const r = await api().pubsub.send(message, picked);
      toast(`${r.count}명에게 공지톡을 보냈습니다`, "info");
      setMessage("");
      setPicked([]);
      setConfirm(false);
      onSent();
    } catch (e) {
      toast(`공지톡을 보내지 못했습니다: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (confirm) {
    return (
      <div className="modal-body">
        <p><strong>{picked.length}명</strong>에게 공지톡을 보냅니다. 보낸 뒤에는 받는 사람에게 바로 알림이 갑니다.</p>
        <div className="pubsub-message">{message.trim()}</div>
        <div className="approval-modal-actions">
          <button className="link" disabled={busy} onClick={() => setConfirm(false)}>취소</button>
          <button className="primary" disabled={busy} onClick={() => void send()}>{picked.length}명에게 보내기</button>
        </div>
      </div>
    );
  }

  return (
    <>
      {caps && !caps.send && <div className="pubsub-note muted small">{caps.reason}</div>}
      {caps?.send && caps.selfOnly && <div className="pubsub-note muted small">{caps.reason}</div>}
      <div className="modal-body" style={{ paddingBottom: 0 }}>
        <textarea
          className="pubsub-input"
          placeholder="공지 내용을 입력하세요"
          maxLength={PUBSUB_MAX_MESSAGE}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>
      <div className="search-box">
        <Icon name="search" size={16} />
        <input placeholder="받는 사람 검색 (이름, 직위, 이메일)" value={q} onChange={(e) => setQ(e.target.value)} />
        {me && (
          <button className="link" title="나에게 보내기" onClick={() => setPicked([{ userId: me.id, name: me.name }])}>나</button>
        )}
      </div>
      {picked.length > 0 && (
        <div className="pubsub-targets" style={{ padding: "0 18px" }}>
          {picked.map((t) => (
            <button key={t.userId} className="tag" title="빼기" onClick={() => toggle(t.userId, t.name ?? "")}>
              {t.name || t.userId} ✕
            </button>
          ))}
        </div>
      )}
      <div className="room-list" style={{ maxHeight: 260, minHeight: 160 }}>
        {loading && <div className="muted small pad">불러오는 중…</div>}
        {!loading && shown.map((p) => (
          <div
            key={p.userId}
            className={`person ${isPicked(p.userId) ? "active" : ""}`}
            role="button"
            onClick={() => toggle(p.userId, p.name)}
          >
            <input type="checkbox" className="pick" checked={isPicked(p.userId)} readOnly />
            <Avatar name={p.name} src={p.thumbnail} size={34} />
            <div className="room-body">
              <div className="room-name">{p.name} <span className="muted small">{p.position}</span></div>
              <div className="room-preview">{p.email}</div>
            </div>
          </div>
        ))}
        {!loading && !shown.length && <div className="empty-list muted">검색 결과가 없습니다</div>}
      </div>
      <div className="approval-modal-actions" style={{ padding: "0 18px 16px" }}>
        {picked.length > 0 && <span className="muted small">{picked.length}명 선택</span>}
        <div className="grow" />
        <button className="primary" disabled={!canSend} title={canSend ? "공지톡 보내기" : caps?.reason} onClick={request}>
          보내기
        </button>
      </div>
    </>
  );
}
