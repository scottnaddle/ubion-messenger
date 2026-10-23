import { useEffect, useState } from "react";
import { api } from "../api";
import { POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, type Poll } from "../../electron/core/polls";
import { applyPollVote, pollMyVotes, pollTotals } from "../lib/polls";
import { useT } from "../lib/i18n";
import { dateLocale } from "../lib/format";

/** 투표 카드: bot message marker [[ubm:poll:<id>]] → interactive vote card (flag on). */
export function PollCard({ pollId, me }: { pollId: number; me: number }) {
  const t = useT();
  const [poll, setPoll] = useState<Poll | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api()
      .polls.get(pollId)
      .then((p) => { if (alive) setPoll(p); })
      .catch((e) => { if (alive) setError((e as Error).message || t("투표를 불러오지 못했습니다")); });
    return () => { alive = false; };
  }, [pollId]);

  const vote = async (optionIndex: number) => {
    if (!poll || poll.closed || busy) return;
    setBusy(true);
    setPoll((p) => (p ? applyPollVote(p, optionIndex, me) : p));
    try {
      const updated = await api().polls.vote(poll.id, optionIndex);
      setPoll(updated);
    } catch {
      setPoll((p) => p);
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    if (!poll || poll.closed || busy) return;
    setBusy(true);
    try {
      setPoll(await api().polls.close(poll.id));
    } catch {
      // keep current state
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="poll-card poll-error">{error}</div>;
  if (!poll) return <div className="poll-card muted tiny">{t("투표 불러오는 중…")}</div>;

  const totals = pollTotals(poll);
  const mine = pollMyVotes(poll, me);
  const totalVotes = totals.reduce((a, b) => a + b, 0);
  const deadlineLabel = poll.deadline
    ? new Date(poll.deadline).toLocaleString(dateLocale(), { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";

  return (
    <div className="poll-card">
      <div className="poll-question">{poll.question}</div>
      {deadlineLabel && <div className="muted tiny">{t("마감: {time}", { time: deadlineLabel })}</div>}
      {poll.options.map((opt, i) => {
        const count = totals[i] ?? 0;
        const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
        const selected = mine.includes(i);
        return (
          <button
            key={i}
            type="button"
            className={`poll-option${selected ? " selected" : ""}`}
            disabled={poll.closed || busy}
            onClick={() => void vote(i)}
          >
            <span className="poll-option-text">{opt}</span>
            <span className="poll-option-meta">
              <span className="poll-bar"><span className="poll-bar-fill" style={{ width: `${pct}%` }} /></span>
              <span className="poll-count">{count}</span>
            </span>
          </button>
        );
      })}
      <div className="poll-foot">
        <span className="muted tiny">{t("총 {n}명 참여", { n: totalVotes })}</span>
        {poll.closed ? (
          <span className="tiny">{t("투표 종료")}</span>
        ) : (
          <button type="button" className="link tiny" disabled={busy} onClick={() => void close()}>{t("투표 종료")}</button>
        )}
      </div>
    </div>
  );
}

/** 투표 만들기 모달: 질문 + 선택지 + 복수 선택 + 마감. On submit calls polls:create. */
export function PollCreateModal({
  roomSeq, onCreated, onClose,
}: { roomSeq: number; onCreated: () => void; onClose: () => void }) {
  const t = useT();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [multiSelect, setMultiSelect] = useState(false);
  const [deadline, setDeadline] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const setOption = (i: number, v: string) => setOptions((o) => o.map((x, j) => (j === i ? v : x)));
  const addOption = () => setOptions((o) => (o.length < POLL_MAX_OPTIONS ? [...o, ""] : o));
  const removeOption = (i: number) => setOptions((o) => (o.length > POLL_MIN_OPTIONS ? o.filter((_, j) => j !== i) : o));

  const submit = async () => {
    const trimmed = options.map((o) => o.trim()).filter(Boolean);
    if (!question.trim()) return setError(t("질문을 입력하세요"));
    if (trimmed.length < POLL_MIN_OPTIONS) return setError(t("선택지를 2개 이상 입력하세요"));
    setBusy(true);
    setError("");
    try {
      const at = deadline ? new Date(deadline).getTime() : undefined;
      if (at != null && Number.isNaN(at)) throw new Error(t("마감 시간이 올바르지 않습니다"));
      await api().polls.create({ roomSeq, question: question.trim(), options: trimmed, multiSelect, deadline: at });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const now = new Date();
  const minLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal compose-discard" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-body">
          <p className="muted small">{t("투표")}</p>
          <input
            autoFocus
            className="poll-input"
            placeholder={t("질문을 입력하세요")}
            value={question}
            maxLength={500}
            onChange={(e) => setQuestion(e.target.value)}
          />
          {options.map((opt, i) => (
            <div key={i} className="poll-option-row">
              <input
                className="poll-input"
                placeholder={t("선택지 {n}", { n: i + 1 })}
                value={opt}
                maxLength={200}
                onChange={(e) => setOption(i, e.target.value)}
              />
              {options.length > POLL_MIN_OPTIONS && (
                <button type="button" className="link" aria-label={t("선택지 삭제")} onClick={() => removeOption(i)}>✕</button>
              )}
            </div>
          ))}
          {options.length < POLL_MAX_OPTIONS && (
            <button type="button" className="link" onClick={addOption}>{t("선택지 추가")}</button>
          )}
          <label className="poll-check">
            <input type="checkbox" checked={multiSelect} onChange={(e) => setMultiSelect(e.target.checked)} />
            <span>{t("복수 선택 허용")}</span>
          </label>
          <label className="poll-deadline">
            <span className="muted tiny">{t("마감 시간 (선택)")}</span>
            <input type="datetime-local" min={minLocal(now)} value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </label>
          {error && <div className="poll-error">{error}</div>}
          <div className="approval-modal-actions">
            <button className="link" onClick={onClose}>{t("취소")}</button>
            <button className="primary" disabled={busy} onClick={() => void submit()}>{t("만들기")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
