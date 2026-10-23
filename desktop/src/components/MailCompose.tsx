import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Person } from "../api";
import { Icon } from "./ui";
import type { MailAddr } from "../../electron/core/mail";
import { MAIL_ATTACH_MAX_BYTES, MAIL_ATTACH_MAX_MB, tooBigMessage } from "../../electron/core/mail-attach";
import {
  MAIL_SEND_ENABLED, draftAsText, isDraftDirty, isEmail, parseRecipients, validateDraft,
  type ComposeAttachment, type MailDraft,
} from "../../electron/core/mail-compose";

export const WRITE_URL = "/app/mail?work=write";
const TITLES = { new: "새 메일", reply: "답장", replyAll: "전체 답장", forward: "전달" } as const;
const fmtSize = (n: number) => (n < 1024 ? `${n}B` : n < 1048576 ? `${Math.round(n / 1024)}KB` : `${(n / 1048576).toFixed(1)}MB`);

/** Pure: suggestions for a recipient query from org users (name / email / position), excluding already-picked. */
export function suggestRecipients(users: Pick<Person, "name" | "email" | "position">[], q: string, picked: MailAddr[], max = 8): MailAddr[] {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const have = new Set(picked.map((a) => a.address.toLowerCase()));
  return users
    .filter((u) => u.email && !have.has(u.email.toLowerCase()) && (u.name.toLowerCase().includes(t) || u.email.toLowerCase().includes(t)))
    .slice(0, max)
    .map((u) => ({ name: u.position ? `${u.name} ${u.position}` : u.name, address: u.email }));
}

function RecipientField({ label, value, onChange, users, autoFocus }: {
  label: string; value: MailAddr[]; onChange: (v: MailAddr[]) => void; users: Person[]; autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const sugg = useMemo(() => suggestRecipients(users, q, value), [users, q, value]);
  const add = (a: MailAddr) => { onChange([...value, a]); setQ(""); setHi(0); };
  const commitTyped = () => {
    const { addrs } = parseRecipients(q);
    if (addrs.length) { onChange([...value, ...addrs.filter((a) => !value.some((v) => v.address === a.address))]); setQ(""); }
  };
  const bad = q.trim() !== "" && !sugg.length && !isEmail(q.replace(/[,;]$/, ""));
  return (
    <div className="compose-row">
      <span className="compose-label">{label}</span>
      <div className="compose-chips">
        {value.map((a) => (
          <span key={a.address} className={`compose-chip ${isEmail(a.address) ? "" : "bad"}`} title={a.address}>
            {a.name || a.address}
            <button type="button" aria-label={`${a.address} 삭제`} onClick={() => onChange(value.filter((v) => v !== a))}>×</button>
          </span>
        ))}
        <input value={q} autoFocus={autoFocus} placeholder={value.length ? "" : "이름 또는 이메일"} className={bad ? "bad" : ""}
          onChange={(e) => { setQ(e.target.value); setHi(0); if (/[,;]$/.test(e.target.value)) setTimeout(commitTyped); }}
          onBlur={() => setTimeout(commitTyped, 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, sugg.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
            else if (e.key === "Enter" || e.key === "Tab") {
              if (sugg[hi]) { e.preventDefault(); add(sugg[hi]); } else if (q.trim()) { e.preventDefault(); commitTyped(); }
            } else if (e.key === "Backspace" && !q && value.length) onChange(value.slice(0, -1));
          }} />
        {sugg.length > 0 && (
          <div className="compose-suggest" role="listbox">
            {sugg.map((s, i) => (
              <button type="button" key={s.address} className={i === hi ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); add(s); }}>
                <b>{s.name}</b> <span className="muted small">{s.address}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function MailCompose({ initial, onClose, onSent }: { initial: MailDraft; onClose: () => void; onSent?: () => void }) {
  const [d, setD] = useState<MailDraft>(initial);
  const [users, setUsers] = useState<Person[]>([]);
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [showBcc, setShowBcc] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmNoSubject, setConfirmNoSubject] = useState(false);
  const [sending, setSending] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { api().call<Person[]>("org:users").then(setUsers).catch(() => undefined); }, []);
  useEffect(() => { if (editor.current) editor.current.innerHTML = initial.html; }, [initial]);

  const set = (p: Partial<MailDraft>) => { setD((x) => ({ ...x, ...p })); setErr(""); };
  const syncBody = () => setD((x) => ({ ...x, html: editor.current?.innerHTML ?? x.html }));
  const fmt = (cmd: string) => { editor.current?.focus(); document.execCommand(cmd); syncBody(); };
  const current = (): MailDraft => ({ ...d, html: editor.current?.innerHTML ?? d.html });
  const dirty = () => isDraftDirty(current(), initial);
  const discard = () => (dirty() ? setConfirmDiscard(true) : onClose());

  const [dragOver, setDragOver] = useState(false);
  const patchAttach = (key: string, p: Partial<ComposeAttachment>) =>
    setD((x) => ({ ...x, attachments: x.attachments.map((a) => (a.key === key ? { ...a, ...p } : a)) }));
  const pickFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    setErr("");
    for (const f of [...files]) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if (f.size > MAIL_ATTACH_MAX_BYTES) { setErr(tooBigMessage(f.name)); continue; }
      setD((x) => ({ ...x, attachments: [...x.attachments, { key, name: f.name, size: f.size, status: "uploading" }] }));
      void (async () => {
        try {
          const up = await api().portal.mailUpload(f.name, await f.arrayBuffer(), f.type || undefined);
          patchAttach(key, { status: "done", uploaded: up, size: up.fileSize || f.size });
        } catch (e) {
          patchAttach(key, { status: "error", error: (e as Error).message || "업로드 실패" });
        }
      })();
    }
  };
  const uploading = d.attachments.some((a) => a.status === "uploading");
  const totalSize = d.attachments.reduce((n, a) => n + (a.size || 0), 0);

  const continueOnWeb = async () => {
    const cur = current();
    const v = validateDraft(cur);
    if (v && cur.to.length) { setErr(v); return; }
    try { await navigator.clipboard.writeText(draftAsText(cur)); setNote("작성한 내용을 클립보드에 복사했습니다. 웹 메일 쓰기 창에 붙여넣으세요."); }
    catch { setNote("클립보드 복사에 실패했습니다. 내용을 직접 옮겨 주세요."); }
    void api().portal.open(WRITE_URL).catch(() => undefined);
  };

  const send = async (allowEmptySubject = false) => {
    const cur = current();
    const v = validateDraft(cur);
    if (v) { setErr(v); return; }
    if (cur.attachments.some((a) => a.status === "uploading")) { setErr("첨부파일 업로드가 끝난 뒤 보내 주세요"); return; }
    if (cur.attachments.some((a) => !a.uploaded)) { setErr("업로드에 실패한 첨부파일을 제거해 주세요"); return; }
    if (!cur.subject.trim() && !allowEmptySubject) { setConfirmNoSubject(true); return; }
    setConfirmNoSubject(false); setSending(true); setErr("");
    try { await api().portal.mailSend(cur); (onSent ?? onClose)(); }
    catch (e) { setErr((e as Error).message || "메일 발송에 실패했습니다"); }
    finally { setSending(false); }
  };

  return (
    <article className={`mail-compose ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDragOver(false); pickFiles(e.dataTransfer.files); }}>
      {dragOver && <div className="compose-drop">여기에 놓으면 첨부됩니다 (파일당 최대 {MAIL_ATTACH_MAX_MB}MB)</div>}
      <header className="mail-compose-head">
        <h3>{TITLES[d.mode]}</h3>
        <div className="mail-compose-actions">
          <button className="primary small" disabled={!MAIL_SEND_ENABLED || sending || uploading} title={uploading ? "첨부파일 업로드 중" : undefined} onClick={() => void send()}>{sending ? "보내는 중…" : "보내기"}</button>
          {!MAIL_SEND_ENABLED && <button className="link" onClick={() => void continueOnWeb()} title="내용을 복사하고 웹 메일 쓰기를 엽니다"><Icon name="external" size={13} /> 웹에서 이어 쓰기</button>}
          <button className="link" onClick={discard}>취소</button>
        </div>
      </header>
      {!MAIL_SEND_ENABLED && <div className="mail-img-bar small">앱 내 발송은 서버 API 확인 후 활성화됩니다. 지금은 ‘웹에서 이어 쓰기’로 보내 주세요.</div>}
      <div className="compose-fields">
        <RecipientField label="받는 사람" value={d.to} onChange={(to) => set({ to })} users={users} autoFocus={d.mode === "new" || d.mode === "forward"} />
        {showCc && <RecipientField label="참조" value={d.cc} onChange={(cc) => set({ cc })} users={users} />}
        {showBcc && <RecipientField label="숨은참조" value={d.bcc} onChange={(bcc) => set({ bcc })} users={users} />}
        {(!showCc || !showBcc) && (
          <div className="compose-toggles">
            {!showCc && <button className="link small" onClick={() => setShowCc(true)}>참조</button>}
            {!showBcc && <button className="link small" onClick={() => setShowBcc(true)}>숨은참조</button>}
          </div>
        )}
        <div className="compose-row">
          <span className="compose-label">제목</span>
          <input className="compose-subject" value={d.subject} maxLength={500} onChange={(e) => set({ subject: e.target.value })} placeholder="제목" />
        </div>
      </div>
      <div className="compose-toolbar">
        <button className="icon-btn" title="굵게" onMouseDown={(e) => { e.preventDefault(); fmt("bold"); }}><b>B</b></button>
        <button className="icon-btn" title="기울임" onMouseDown={(e) => { e.preventDefault(); fmt("italic"); }}><i>I</i></button>
        <button className="icon-btn" title="밑줄" onMouseDown={(e) => { e.preventDefault(); fmt("underline"); }}><u>U</u></button>
        <button className="icon-btn" title="글머리 기호" onMouseDown={(e) => { e.preventDefault(); fmt("insertUnorderedList"); }}>•</button>
        <button className="icon-btn" title="번호 매기기" onMouseDown={(e) => { e.preventDefault(); fmt("insertOrderedList"); }}>1.</button>
        <span className="spacer" />
        <button className="link small" onClick={() => fileRef.current?.click()}><Icon name="clip" size={13} /> 파일 첨부</button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }} />
      </div>
      {d.attachments.length > 0 && (
        <div className="compose-attaches">
          <div className="muted tiny">첨부 {d.attachments.length}개 · {fmtSize(totalSize)}{uploading ? " · 업로드 중…" : ""}</div>
          {d.attachments.map((a, i) => (
            <div key={a.key ?? `${a.name}/${i}`} className={`compose-attach ${a.status ?? ""}`}>
              <Icon name="clip" size={13} />
              <span className="ca-name ellipsis" title={a.name}>{a.name}</span>
              <span className="muted tiny">{fmtSize(a.size)}</span>
              {a.status === "uploading" && <span className="ca-progress" aria-label="업로드 중"><span /></span>}
              {a.status === "done" && <span className="ca-ok tiny">완료</span>}
              {a.status === "error" && <span className="error tiny" title={a.error}>{a.error || "실패"}</span>}
              <button type="button" className="icon-btn" aria-label={`${a.name} 삭제`} onClick={() => setD((x) => ({ ...x, attachments: x.attachments.filter((_, j) => j !== i) }))}>×</button>
            </div>
          ))}
        </div>
      )}
      <div ref={editor} className="compose-body" contentEditable suppressContentEditableWarning onInput={syncBody} onBlur={syncBody} />
      {err && <div className="error small pad">{err}</div>}
      {note && <div className="muted small pad">{note}</div>}
      {confirmNoSubject && (
        <div className="modal-back" onClick={() => setConfirmNoSubject(false)}>
          <div className="modal compose-discard" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="modal-body">
              <h3>제목 없이 보낼까요?</h3>
              <p className="muted small">제목이 비어 있습니다.</p>
              <div className="approval-modal-actions">
                <button className="link" onClick={() => setConfirmNoSubject(false)}>취소</button>
                <button className="primary small" onClick={() => void send(true)}>보내기</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {confirmDiscard && (
        <div className="modal-back" onClick={() => setConfirmDiscard(false)}>
          <div className="modal compose-discard" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="modal-body">
              <h3>작성 중인 메일을 버릴까요?</h3>
              <p className="muted small">임시 저장은 지원하지 않아 작성한 내용이 사라집니다.</p>
              <div className="approval-modal-actions">
                <button className="link" onClick={() => setConfirmDiscard(false)}>계속 작성</button>
                <button className="danger-btn" onClick={onClose}>버리기</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
