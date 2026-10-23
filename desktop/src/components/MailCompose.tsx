import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Person } from "../api";
import { Icon } from "./ui";
import type { MailAddr } from "../../electron/core/mail";
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

export function MailCompose({ initial, onClose }: { initial: MailDraft; onClose: () => void }) {
  const [d, setD] = useState<MailDraft>(initial);
  const [users, setUsers] = useState<Person[]>([]);
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [showBcc, setShowBcc] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
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

  const pickFiles = (files: FileList | null) => {
    if (!files) return;
    const add: ComposeAttachment[] = [...files].map((f) => ({ name: f.name, size: f.size, path: api().pathForFile?.(f) || undefined }));
    set({ attachments: [...d.attachments, ...add] });
  };

  const continueOnWeb = async () => {
    const cur = current();
    const v = validateDraft(cur);
    if (v && cur.to.length) { setErr(v); return; }
    try { await navigator.clipboard.writeText(draftAsText(cur)); setNote("작성한 내용을 클립보드에 복사했습니다. 웹 메일 쓰기 창에 붙여넣으세요."); }
    catch { setNote("클립보드 복사에 실패했습니다. 내용을 직접 옮겨 주세요."); }
    void api().portal.open(WRITE_URL).catch(() => undefined);
  };

  const send = async () => {
    const cur = current();
    const v = validateDraft(cur);
    if (v) { setErr(v); return; }
    try { await api().portal.mailSend(cur); onClose(); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <article className="mail-compose">
      <header className="mail-compose-head">
        <h3>{TITLES[d.mode]}</h3>
        <div className="mail-compose-actions">
          {MAIL_SEND_ENABLED
            ? <button className="primary small" onClick={() => void send()}>보내기</button>
            : <>
                <button className="primary small" disabled title="발송 API 검증 전까지 비활성화">보내기</button>
                <button className="link" onClick={() => void continueOnWeb()} title="내용을 복사하고 웹 메일 쓰기를 엽니다"><Icon name="external" size={13} /> 웹에서 이어 쓰기</button>
              </>}
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
          {d.attachments.map((a, i) => (
            <span key={`${a.name}/${i}`} className="compose-chip">
              {a.name} <span className="muted tiny">{fmtSize(a.size)}</span>
              <button type="button" aria-label={`${a.name} 삭제`} onClick={() => set({ attachments: d.attachments.filter((_, j) => j !== i) })}>×</button>
            </span>
          ))}
          <span className="muted tiny">첨부 업로드는 발송 API 확인 후 지원됩니다</span>
        </div>
      )}
      <div ref={editor} className="compose-body" contentEditable suppressContentEditableWarning onInput={syncBody} onBlur={syncBody} />
      {err && <div className="error small pad">{err}</div>}
      {note && <div className="muted small pad">{note}</div>}
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
