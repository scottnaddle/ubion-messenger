import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "./ui";
import { tk, useT } from "../lib/i18n";
import { sanitizeHtml } from "../lib/sanitize";
import {
  APPROVAL_BOXES, APPROVAL_BOX_LABELS,
  type ApprovalActivity, type ApprovalBox, type ApprovalDocumentDetail, type ApprovalList, type ApprovalListItem,
} from "../../electron/core/portal";

const open = (url: string) => void api().portal.open(url).catch(() => undefined);
const docUrl = (id: number) => `/app/approval/document/${id}`;
/** Box labels come from APPROVAL_BOX_LABELS (core); listed here so the i18n key scanner sees them. */
const BOX_LABEL: Record<ApprovalBox, string> = {
  todo: tk("결재 대기"), upcoming: tk("결재 예정"), draft: tk("기안 문서"), approve: tk("결재한 문서"),
};
const boxLabel = (b: ApprovalBox) => APPROVAL_BOX_LABELS[b] || BOX_LABEL[b];

function dt(s?: string) {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtSize(n: number) {
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function statusClass(a: ApprovalActivity) {
  const s = `${a.status} ${a.statusName}`.toLowerCase();
  if (/reject|return|반려|반송/.test(s)) return "reject";
  if (/approv|agree|complete|done|승인|완료|합의/.test(s)) return "done";
  if (/wait|진행|대기/.test(s)) return "wait";
  return "";
}

function FlowGroup({ name, activities }: { name: string; activities: ApprovalActivity[] }) {
  if (!activities.length) return null;
  return (
    <div className="flow-group">
      {name && <div className="flow-group-name muted small">{name}</div>}
      <div className="flow-steps">
        {activities.map((a, i) => (
          <div className={`flow-step ${statusClass(a)}`} key={i}>
            <div className="flow-dot">{i + 1}</div>
            <div className="flow-info">
              <b>{a.userName || a.name || "-"}</b>
              <span className="muted small">{[a.deptName, a.userPosition].filter(Boolean).join(" · ")}</span>
              <span className="flow-status">{a.statusName || a.status || a.name}</span>
              {a.completedAt && <span className="muted tiny">{dt(a.completedAt)}</span>}
              {a.comment && <span className="flow-comment">{a.comment}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Only the current approver/agreer/checker/inspector may act (per the server's actionCheck flags). */
export const canAct = (d: ApprovalDocumentDetail) =>
  ["isApprovalWaitingUser", "isAgreementWaitingUser", "isCheckWaitingUser", "isInspectionWaitingUser", "isApprovalDeputy", "isAgreementDeputy"].some((k) => d.actionCheck?.[k]);

export function Approval() {
  const t = useT();
  const [box, setBox] = useState<ApprovalBox>("todo");
  const [page, setPage] = useState(0);
  const [kw, setKw] = useState("");
  const [query, setQuery] = useState("");
  const [list, setList] = useState<ApprovalList | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [counts, setCounts] = useState<Partial<Record<ApprovalBox, number>>>({});
  const [sel, setSel] = useState<ApprovalListItem | null>(null);
  const [detail, setDetail] = useState<ApprovalDocumentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const detailReq = useRef(0);

  const loadCounts = useCallback(async () => {
    try {
      const c = await api().portal.approvalCounts();
      setCounts((v) => ({ ...v, todo: c.todo, upcoming: c.upcoming }));
    } catch {}
  }, []);

  const loadList = useCallback(async () => {
    setListLoading(true);
    setListError("");
    try {
      const r = await api().portal.approvalList(box, page, query);
      setList(r);
      setCounts((v) => ({ ...v, [box]: r.page.total }));
    } catch (e) {
      setListError((e as Error).message);
    } finally {
      setListLoading(false);
    }
  }, [box, page, query]);

  useEffect(() => {
    void loadCounts();
    void (async () => {
      for (const b of ["draft", "approve"] as const) {
        try {
          const r = await api().portal.approvalList(b, 0, "");
          setCounts((v) => ({ ...v, [b]: r.page.total }));
        } catch {}
      }
    })();
  }, [loadCounts]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openDoc = useCallback(async (item: ApprovalListItem) => {
    const n = ++detailReq.current;
    setSel(item);
    setDetail(null);
    setDetailError("");
    setDetailLoading(true);
    try {
      const d = await api().portal.approvalDoc(item.documentId ?? item.id);
      if (n === detailReq.current) setDetail(d);
    } catch (e) {
      if (n === detailReq.current) setDetailError((e as Error).message);
    } finally {
      if (n === detailReq.current) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!list) return;
    const same = sel && list.items.some((i) => (i.documentId ?? i.id) === (sel.documentId ?? sel.id));
    if (same) return;
    const first = list.items[0];
    if (first) void openDoc(first);
    else {
      detailReq.current++;
      setSel(null);
      setDetail(null);
      setDetailError("");
      setDetailLoading(false);
    }
  }, [list, sel, openDoc]);

  const chooseBox = (b: ApprovalBox) => {
    if (b === box && page === 0) {
      // Same box clicked again: deps don't change, so reload explicitly instead of blanking the list.
      void loadList();
      return;
    }
    setBox(b);
    setPage(0);
    setList(null);
    setSel(null);
    setDetail(null);
    setDetailError("");
  };

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(0);
    setQuery(kw.trim());
  };

  const retryDetail = () => {
    if (sel) void openDoc(sel);
  };

  const [action, setAction] = useState<null | { kind: "approve" | "return"; docId: number }>(null);
  const [comment, setComment] = useState("");
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [toast, setToast] = useState("");

  const ask = (kind: "approve" | "return") => {
    if (!detail) return;
    setAction({ kind, docId: detail.document.id });
    setComment("");
    setActionError("");
  };

  const submitAction = async () => {
    if (!action || acting) return;
    const label = action.kind === "approve" ? t("승인") : t("반려");
    if (action.kind === "return" && !comment.trim()) {
      setActionError(t("반려 사유를 입력하세요"));
      return;
    }
    setActing(true);
    setActionError("");
    try {
      await api().portal.approvalAction(action.kind, action.docId, comment.trim());
      setAction(null);
      setToast(t("{action} 처리되었습니다", { action: label }));
      setTimeout(() => setToast(""), 3000);
      setSel(null);
      setDetail(null);
      void loadCounts();
      void loadList();
    } catch (e) {
      setActionError(t("{action} 실패: {error}", { action: label, error: (e as Error).message || t("알 수 없는 오류") }));
    } finally {
      setActing(false);
    }
  };

  const totalPage = Math.max(1, list?.page.totalPage || Math.ceil((list?.page.total || 0) / (list?.page.offset || 20)));
  const currentPage = list?.page.page ?? page;

  return (
    <div className="approval">
      <aside className="approval-boxes">
        <div className="side-head home-head"><h2>{t("전자결재")}</h2></div>
        {APPROVAL_BOXES.map((b) => (
          <button key={b} className={`approval-box ${box === b ? "on" : ""}`} onClick={() => chooseBox(b)}>
            <span>{t(boxLabel(b))}</span>
            <span className="badge quiet">{counts[b] == null ? "-" : counts[b]! > 99 ? "99+" : counts[b]}</span>
          </button>
        ))}
        <button className="icon-btn approval-refresh" title={t("새로고침")} onClick={() => { void loadCounts(); void loadList(); }}>
          <Icon name="refresh" size={18} />
        </button>
      </aside>

      <section className="approval-list">
        <form className="search-box approval-search" onSubmit={search}>
          <Icon name="search" size={16} />
          <input placeholder={t("문서 제목 검색")} value={kw} onChange={(e) => setKw(e.target.value)} />
          <button className="link" type="submit" disabled={!kw.trim()}>{t("검색")}</button>
        </form>
        <div className="approval-list-head">
          <b>{t(boxLabel(box))}</b>
          <span className="muted small">{currentPage + 1} / {totalPage}</span>
        </div>
        <div className="approval-items">
          {listError && (
            <div className="approval-error">
              <span>{listError}</span>
              <button className="link" onClick={() => void loadList()}>{t("다시 시도")}</button>
            </div>
          )}
          {listLoading && !list && <div className="muted small pad">{t("불러오는 중…")}</div>}
          {list && !list.items.length && !listError && <div className="muted small pad">{t("문서가 없습니다")}</div>}
          {list?.items.map((d) => {
            const id = d.documentId ?? d.id;
            const on = sel != null && (sel.documentId ?? sel.id) === id;
            return (
              <button key={id} className={`approval-item ${on ? "active" : ""}`} onClick={() => void openDoc(d)}>
                <div className="approval-item-top">
                  <span className="ellipsis">{d.title || t("(제목 없음)")}</span>
                  {d.emergency && <span className="approval-emergency">{t("긴급")}</span>}
                </div>
                <div className="approval-item-meta">
                  <span className="tag">{d.formName}</span>
                  {(d.apprStatusName || d.docStatusName) && <span className="approval-status">{d.apprStatusName || d.docStatusName}</span>}
                  {d.attachCount > 0 && <span className="muted small"><Icon name="clip" size={12} /> {d.attachCount}</span>}
                </div>
                <div className="approval-item-foot">
                  <span className="ellipsis">{[d.drafterName, d.drafterDeptName].filter(Boolean).join(" · ")}</span>
                  <span className="muted small">{dt(d.draftedAt)}</span>
                </div>
              </button>
            );
          })}
        </div>
        <div className="approval-pager">
          <button className="link" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>{t("◀ 이전")}</button>
          <span className="muted small">{currentPage + 1} / {totalPage}</span>
          <button className="link" disabled={page + 1 >= totalPage} onClick={() => setPage((p) => p + 1)}>{t("다음 ▶")}</button>
        </div>
      </section>

      <section className="approval-detail">
        {detailLoading && !detail && <div className="muted small pad">{t("불러오는 중…")}</div>}
        {detailError && !detailLoading && (
          <div className="approval-error pad">
            <span>{detailError}</span>
            <button className="link" onClick={retryDetail}>{t("다시 시도")}</button>
          </div>
        )}
        {!sel && !detailLoading && !detailError && <div className="muted small pad">{t("문서를 선택하세요")}</div>}
        {detail && (
          <>
            <header className="approval-detail-head">
              <div className="approval-title">
                <span className="tag">{detail.document.formName}</span>
                <h3>{detail.document.title || t("(제목 없음)")}</h3>
              </div>
              <div className="approval-actions">
                {canAct(detail) && <>
                  <button className="primary small" onClick={() => ask("approve")}>{t("승인")}</button>
                  <button className="danger-btn" onClick={() => ask("return")}>{t("반려")}</button>
                </>}
                <button className="link" onClick={() => open(docUrl(detail.document.id))}>{t("웹에서 열기")}</button>
              </div>
            </header>
            <div className="approval-meta">
              <span>{detail.document.docStatusName}</span>
              <span>{[detail.document.drafterName, detail.document.drafterDeptName, detail.document.drafterPositionName].filter(Boolean).join(" · ")}</span>
              <span className="muted small">{dt(detail.document.draftedAt)}</span>
            </div>
            <section className="approval-flow">
              {detail.apprFlow.activityGroups.map((g, i) => (
                <FlowGroup key={i} name={g.name} activities={g.activities} />
              ))}
              {!detail.apprFlow.activityGroups.length && <div className="muted small">{t("결재선 정보가 없습니다")}</div>}
            </section>
            <div className="approval-body-wrap">
              <div className="approval-body" dangerouslySetInnerHTML={{ __html: sanitizeHtml(detail.document.bodyHtml) }} />
            </div>
            <section className="approval-attaches">
              <h4>{t("첨부파일")} {detail.document.attaches.length ? `(${detail.document.attaches.length})` : ""}</h4>
              {!detail.document.attaches.length && <div className="muted small">{t("첨부파일이 없습니다")}</div>}
              {detail.document.attaches.map((a) => (
                <button key={a.id} className="approval-attach" onClick={() => open(`/api/approval/document/${detail.document.id}/download/${encodeURIComponent(a.id)}`)}>
                  <Icon name="download" size={15} />
                  <span className="ellipsis">{a.name}</span>
                  <span className="muted small">{fmtSize(a.size)}</span>
                </button>
              ))}
            </section>
            <section className="approval-comments">
              <h4>{t("댓글")} {detail.comments.length ? `(${detail.comments.length})` : ""}</h4>
              {!detail.comments.length && <div className="muted small">{t("댓글이 없습니다")}</div>}
              {detail.comments.map((c) => (
                <div className="approval-comment" key={c.id}>
                  <div className="approval-comment-head">
                    <b>{c.author || t("알 수 없음")}</b>
                    <span className="muted tiny">{dt(c.createdAt)}</span>
                  </div>
                  <div className="approval-comment-body">{c.content || t("(내용 없음)")}</div>
                </div>
              ))}
            </section>
          </>
        )}
      </section>
      {toast && <div className="approval-toast" role="status">{toast}</div>}
      {action && (
        <div className="modal-back" onClick={() => !acting && setAction(null)}>
          <div className="modal approval-action-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="modal-body">
              <h3>{action.kind === "approve" ? t("결재 승인") : t("결재 반려")}</h3>
              <p className="muted small">{detail?.document.title || t("(제목 없음)")}</p>
              <label className="small">
                {action.kind === "approve" ? t("의견 (선택)") : t("반려 사유 (필수)")}
                <textarea className="approval-comment-input" rows={4} maxLength={1000} value={comment} autoFocus
                  placeholder={action.kind === "approve" ? t("의견을 입력하세요") : t("반려 사유를 입력하세요")}
                  onChange={(e) => setComment(e.target.value)} disabled={acting} />
              </label>
              {actionError && <div className="error small">{actionError}</div>}
              <div className="approval-modal-actions">
                <button className="link" onClick={() => setAction(null)} disabled={acting}>{t("취소")}</button>
                <button className={action.kind === "approve" ? "primary small" : "danger-btn"} onClick={() => void submitAction()}
                  disabled={acting || (action.kind === "return" && !comment.trim())}>
                  {acting ? t("처리 중…") : action.kind === "approve" ? t("승인") : t("반려")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
