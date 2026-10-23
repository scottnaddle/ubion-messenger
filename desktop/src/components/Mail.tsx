import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "./ui";
import { sanitizeMailHtml } from "../lib/sanitize";
import { fileIcon } from "../../electron/core/attach";
import { mailOverview, type MailListItem, type MailListPage, type MailMessage } from "../../electron/core/mail";
import { MailCompose } from "./MailCompose";
import { buildDraft, type ComposeMode, type MailDraft } from "../../electron/core/mail-compose";
import { mailUrl, type MailFolder, type MailFolders } from "../../electron/core/portal";

const open = (url: string) => void api().portal.open(url).catch(() => undefined);
const openExternal = (url: string) => void api().call("app:openExternal", url).catch(() => undefined);
export { WRITE_URL } from "./MailCompose";
import { WRITE_URL } from "./MailCompose";

/** Today → HH:mm, this year → M.D, else YYYY.M.D (Asia/Seoul via the OS locale/zone). */
export function mailDate(s?: string, now = new Date()): string {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}.${d.getDate()}`;
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}
const fullDate = (s?: string) => (s ? new Date(s).toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short", hour12: false }) : "");

function FolderGroup({ title, folders, cur, onPick }: { title?: string; folders: MailFolder[]; cur: string; onPick: (f: MailFolder) => void }) {
  if (!folders.length) return null;
  return (
    <section className="mail-group">
      {title && <h4 className="muted small">{title}</h4>}
      {folders.map((f) => (
        <button key={`${f.id}/${f.fullName}`} className={`mail-folder ${cur === f.fullName ? "on" : ""}`} style={{ paddingLeft: 10 + f.depth * 12 }} onClick={() => onPick(f)} title={f.name}>
          <Icon name="mail" size={15} />
          <span className="ellipsis">{f.name}</span>
          {f.unseenCnt > 0 && <span className="badge">{f.unseenCnt > 999 ? "999+" : f.unseenCnt}</span>}
        </button>
      ))}
    </section>
  );
}

/** Sandboxed iframe (no scripts) so mail CSS can't touch the app; links → external browser. */
function MailBody({ html, onHeight }: { html: string; onHeight?: (h: number) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(200);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
    body{margin:0;font:14px/1.6 -apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#1f2328;word-break:break-word;overflow-wrap:anywhere}
    img{max-width:100%;height:auto} img[data-blocked]{display:inline-block;min-width:16px;min-height:16px;background:#f1f3f5;outline:1px dashed #ced4da}
    table{max-width:100%} pre{white-space:pre-wrap} a{color:#2f6fdb}
  </style></head><body>${html}</body></html>`;
  const onLoad = () => {
    const d = ref.current?.contentDocument;
    if (!d) return;
    d.addEventListener("click", (e) => {
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("data-ext-href");
      if (href && /^https?:/i.test(href)) openExternal(href);
    });
    const fit = () => { const nh = Math.max(120, d.documentElement.scrollHeight); setH(nh); onHeight?.(nh); };
    fit();
    d.querySelectorAll("img").forEach((i) => i.addEventListener("load", fit));
  };
  // allow-same-origin (no allow-scripts) lets the parent measure height and intercept clicks; nothing in the mail can run.
  return <iframe ref={ref} className="mail-frame" title="메일 본문" sandbox="allow-same-origin" srcDoc={doc} style={{ height: h }} onLoad={onLoad} />;
}

function Overview({ page, inboxUnread, folders, onSender, onPick }: {
  page: MailListPage | null; inboxUnread: number; folders: MailFolders | null; onSender: (q: string) => void; onPick: (m: MailListItem) => void;
}) {
  const o = mailOverview(page, inboxUnread);
  const percent = folders ? Math.max(0, Math.min(100, folders.quota.percent)) : 0;
  return (
    <div className="mail-overview">
      <div className="mail-ov-cards">
        <div className="mail-ov-card"><span className="muted small">안 읽은 메일</span><b>{o.unread}</b><span className="muted tiny">받은편지함</span></div>
        <div className="mail-ov-card"><span className="muted small">중요 · 별표</span><b>{o.important}</b><span className="muted tiny">현재 목록</span></div>
        <div className="mail-ov-card"><span className="muted small">첨부 있는 메일</span><b>{o.withAttach}</b><span className="muted tiny">현재 목록</span></div>
        <div className="mail-ov-card"><span className="muted small">용량</span><b>{percent}%</b>
          <div className="mail-quota-bar"><i style={{ width: `${percent}%` }} /></div>
        </div>
      </div>
      <div className="mail-ov-cols">
        <section className="mail-ov-sec">
          <h4>최근 보낸 사람</h4>
          {!o.recentSenders.length && <div className="muted small">메일이 없습니다</div>}
          {o.recentSenders.map((s) => (
            <button key={s.address || s.name} className="mail-ov-row" onClick={() => onSender(s.address || s.name)} title={`${s.address} 메일 검색`}>
              <span className="mail-ov-av">{(s.name || "?").slice(0, 1)}</span>
              <span className="ellipsis">{s.name}<span className="muted tiny"> {s.address !== s.name ? s.address : ""}</span></span>
              <span className="muted small">{s.count}통{s.unread ? ` · 새 ${s.unread}` : ""}</span>
            </button>
          ))}
        </section>
        <section className="mail-ov-sec">
          <h4>중요 메일</h4>
          {!o.importantItems.length && <div className="muted small">중요 표시된 메일이 없습니다</div>}
          {o.importantItems.map((m) => (
            <button key={m.uid} className="mail-ov-row" onClick={() => onPick(m)}>
              <span className="mail-imp">!</span>
              <span className="ellipsis">{m.subject || "(제목 없음)"}</span>
              <span className="muted small">{mailDate(m.dateUtc)}</span>
            </button>
          ))}
        </section>
      </div>
      <div className="mail-ov-actions">
        <button className="primary small" onClick={() => open(WRITE_URL)}><Icon name="external" size={14} /> 웹에서 메일 쓰기</button>
        <span className="muted tiny">메일을 선택하면 여기에서 바로 읽을 수 있습니다. 쓰기·답장은 웹 메일에서 열립니다.</span>
      </div>
    </div>
  );
}

export function Mail() {
  const [folders, setFolders] = useState<MailFolders | null>(null);
  const [folderErr, setFolderErr] = useState("");
  const [folder, setFolder] = useState("Inbox");
  const [kw, setKw] = useState("");
  const [query, setQuery] = useState("");
  const [list, setList] = useState<MailListPage | null>(null);
  const [items, setItems] = useState<MailListItem[]>([]);
  const [listErr, setListErr] = useState("");
  const [listLoading, setListLoading] = useState(false);
  const [sel, setSel] = useState<MailListItem | null>(null);
  const [msg, setMsg] = useState<MailMessage | null>(null);
  const [msgErr, setMsgErr] = useState("");
  const [msgLoading, setMsgLoading] = useState(false);
  const [showImages, setShowImages] = useState(false);
  const listReq = useRef(0);
  const msgReq = useRef(0);

  const loadFolders = useCallback(async () => {
    setFolderErr("");
    try { setFolders(await api().portal.mailFolders()); } catch (e) { setFolderErr((e as Error).message); }
  }, []);

  const loadPage = useCallback(async (page: number) => {
    const req = ++listReq.current;
    setListLoading(true);
    setListErr("");
    try {
      const r = await api().portal.mailList(folder, page, query);
      if (req !== listReq.current) return;
      setList(r);
      setItems((prev) => (page === 1 ? r.items : [...prev, ...r.items.filter((m) => !prev.some((p) => p.uid === m.uid))]));
    } catch (e) {
      if (req === listReq.current) setListErr((e as Error).message);
    } finally {
      if (req === listReq.current) setListLoading(false);
    }
  }, [folder, query]);

  useEffect(() => { void loadFolders(); }, [loadFolders]);
  useEffect(() => { setItems([]); setList(null); void loadPage(1); }, [loadPage]);

  const allFolders = useMemo(() => (folders ? [...folders.defaultFolders, ...folders.userFolders, ...folders.userSharedFolders] : []), [folders]);
  const curFolder = allFolders.find((f) => f.fullName === folder);
  const inboxUnread = allFolders.find((f) => f.fullName === "Inbox")?.unseenCnt ?? (folder === "Inbox" ? list?.unread ?? 0 : 0);

  const pickFolder = (f: MailFolder) => { setFolder(f.fullName); setSel(null); setMsg(null); setKw(""); setQuery(""); };
  const search = (e?: React.FormEvent, q = kw) => { e?.preventDefault(); setKw(q); setQuery(q.trim()); setSel(null); setMsg(null); };

  /** Opening = server read call, which marks the message read (normal mail behaviour). */
  const openMsg = async (m: MailListItem) => {
    const req = ++msgReq.current;
    setSel(m); setMsg(null); setMsgErr(""); setMsgLoading(true); setShowImages(false);
    try {
      const r = await api().portal.mailRead(m.folder, m.uid);
      if (req !== msgReq.current) return;
      setMsg(r);
      if (!m.seen) {
        setItems((prev) => prev.map((x) => (x.uid === m.uid && x.folder === m.folder ? { ...x, seen: true } : x)));
        setFolders((fs) => fs && ({
          ...fs,
          defaultFolders: fs.defaultFolders.map((f) => (f.fullName === m.folder ? { ...f, unseenCnt: Math.max(0, f.unseenCnt - 1) } : f)),
          userFolders: fs.userFolders.map((f) => (f.fullName === m.folder ? { ...f, unseenCnt: Math.max(0, f.unseenCnt - 1) } : f)),
        }));
        void api().portal.refresh().catch(() => undefined); // keep the mail/home badges in sync
      }
    } catch (e) {
      if (req === msgReq.current) setMsgErr((e as Error).message);
    } finally {
      if (req === msgReq.current) setMsgLoading(false);
    }
  };

  const [compose, setCompose] = useState<MailDraft | null>(null);
  const [myEmail, setMyEmail] = useState("");
  useEffect(() => {
    Promise.all([api().call<{ user: { id: number } | null }>("auth:state"), api().call<{ userId: number; email: string }[]>("org:users")])
      .then(([st, us]) => setMyEmail(us.find((u) => u.userId === st?.user?.id)?.email ?? ""))
      .catch(() => undefined);
  }, []);
  const startCompose = (mode: ComposeMode) => {
    const quoted = mode !== "new" && msg ? sanitizeMailHtml(msg.html, false).html : "";
    setCompose(buildDraft(mode, mode === "new" ? null : msg, myEmail, quoted, msg ? fullDate(msg.dateUtc) : ""));
  };

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (!listLoading && list && !list.lastPage && el.scrollTop + el.clientHeight > el.scrollHeight - 120) void loadPage(list.page + 1);
  };

  const body = useMemo(() => (msg ? sanitizeMailHtml(msg.html, showImages) : null), [msg, showImages]);
  const percent = folders ? Math.max(0, Math.min(100, folders.quota.percent)) : 0;

  return (
    <div className="mail3">
      <aside className="mail-pane-folders">
        <div className="side-head home-head">
          <h2>메일</h2>
          <button className="icon-btn" title="새로고침" onClick={() => { void loadFolders(); setItems([]); void loadPage(1); }}>
            <Icon name="refresh" size={18} />
          </button>
        </div>
        <button className="primary small mail-write" onClick={() => startCompose("new")} title="새 메일 쓰기">
          <Icon name="plus" size={15} /> 메일 쓰기
        </button>
        <div className="mail-folders">
          {folderErr && <div className="mail-error"><span>{folderErr}</span><button className="link" onClick={() => void loadFolders()}>다시 시도</button></div>}
          {!folders && !folderErr && <div className="muted small pad">불러오는 중…</div>}
          {folders && <>
            <FolderGroup folders={folders.defaultFolders} cur={folder} onPick={pickFolder} />
            <FolderGroup title="내 폴더" folders={folders.userFolders} cur={folder} onPick={pickFolder} />
            <FolderGroup title="공유 폴더" folders={folders.userSharedFolders} cur={folder} onPick={pickFolder} />
          </>}
        </div>
        {folders && (
          <section className="mail-quota">
            <div className="mail-quota-top"><span className="small">용량</span><span className="muted tiny">{percent}%{folders.quota.usageUnit ? ` · ${folders.quota.usageUnit} / ${folders.quota.limitUnit}` : ""}</span></div>
            <div className="mail-quota-bar"><i style={{ width: `${percent}%` }} /></div>
          </section>
        )}
      </aside>

      <section className="mail-pane-list">
        <form className="search-box mail-search" onSubmit={search}>
          <Icon name="search" size={16} />
          <input placeholder={`${curFolder?.name || "메일함"}에서 검색`} value={kw} onChange={(e) => setKw(e.target.value)} />
          {query && <button type="button" className="link" onClick={() => search(undefined, "")}>지우기</button>}
          <button className="link" type="submit" disabled={!kw.trim()}>검색</button>
        </form>
        <div className="mail-list-head">
          <b className="ellipsis">{query ? `“${query}” 검색 결과` : curFolder?.name || list?.folderName || folder}</b>
          <span className="muted small">{list ? `${list.total.toLocaleString()}통${!query && list.unread ? ` · 안 읽음 ${list.unread.toLocaleString()}` : ""}` : ""}</span>
        </div>
        <div className="mail-items" onScroll={onScroll}>
          {listErr && <div className="mail-error"><span>{listErr}</span><button className="link" onClick={() => void loadPage(list ? list.page + (items.length ? 1 : 0) : 1)}>다시 시도</button></div>}
          {listLoading && !items.length && <div className="muted small pad">불러오는 중…</div>}
          {list && !items.length && !listLoading && !listErr && <div className="muted small pad">{query ? "검색 결과가 없습니다" : "메일이 없습니다"}</div>}
          {items.map((m) => (
            <button key={`${m.folder}/${m.uid}`} className={`mail-item ${m.seen ? "" : "unread"} ${sel?.uid === m.uid && sel.folder === m.folder ? "active" : ""}`} onClick={() => void openMsg(m)}>
              <span className="mail-dot" aria-label={m.seen ? "" : "안 읽음"} />
              <div className="mail-item-main">
                <div className="mail-item-top">
                  <span className="mail-from ellipsis">{m.from.name || m.from.address || "(보낸 사람 없음)"}</span>
                  {m.hasAttach && <span className="muted" title="첨부파일"><Icon name="clip" size={13} /></span>}
                  <span className="muted tiny mail-date">{mailDate(m.dateUtc)}</span>
                </div>
                <div className="mail-subject ellipsis">{m.important && <span className="mail-imp">!</span>}{m.subject || "(제목 없음)"}</div>
                <div className="mail-snippet ellipsis muted small">{m.preview}</div>
              </div>
            </button>
          ))}
          {list && !list.lastPage && items.length > 0 && (
            <button className="link mail-more" disabled={listLoading} onClick={() => void loadPage(list.page + 1)}>{listLoading ? "불러오는 중…" : "더 보기"}</button>
          )}
        </div>
      </section>

      <section className="mail-pane-read">
        {compose && <MailCompose key={JSON.stringify(compose).length + compose.mode + (compose.ref?.uid ?? "")} initial={compose} onClose={() => setCompose(null)} />}
        {!compose && !sel && <Overview page={list} inboxUnread={inboxUnread} folders={folders} onSender={(q) => search(undefined, q)} onPick={(m) => void openMsg(m)} />}
        {!compose && sel && msgLoading && <div className="muted small pad">불러오는 중…</div>}
        {!compose && sel && msgErr && <div className="mail-error pad"><span>{msgErr}</span><button className="link" onClick={() => void openMsg(sel)}>다시 시도</button></div>}
        {!compose && sel && msg && body && (
          <article className="mail-read">
            <header className="mail-read-head">
              <div className="mail-read-title">
                <h3>{msg.important && <span className="mail-imp">!</span>}{msg.subject || "(제목 없음)"}</h3>
                <div className="mail-read-actions">
                  <button className="link" onClick={() => startCompose("reply")}>↩ 답장</button>
                  <button className="link" onClick={() => startCompose("replyAll")}>전체 답장</button>
                  <button className="link" onClick={() => startCompose("forward")}>→ 전달</button>
                  <button className="link" onClick={() => open(mailUrl(msg.folder, String(msg.uid)))}>웹에서 열기</button>
                  <button className="icon-btn" title="닫기" onClick={() => { setSel(null); setMsg(null); }}><Icon name="close" size={16} /></button>
                </div>
              </div>
              <div className="mail-read-meta">
                <span className="mail-ov-av">{(msg.from.name || "?").slice(0, 1)}</span>
                <div className="mail-read-addrs">
                  <div><b>{msg.from.name}</b> <span className="muted small">&lt;{msg.from.address}&gt;</span></div>
                  {msg.to.length > 0 && <div className="muted small ellipsis">받는 사람: {msg.to.map((a) => a.name).join(", ")}</div>}
                  {msg.cc.length > 0 && <div className="muted small ellipsis">참조: {msg.cc.map((a) => a.name).join(", ")}</div>}
                </div>
                <span className="muted small">{fullDate(msg.dateUtc)}</span>
              </div>
            </header>
            {body.blockedImages > 0 && !showImages && (
              <div className="mail-img-bar">
                <span className="small">개인정보 보호를 위해 외부 이미지 {body.blockedImages}개를 차단했습니다.</span>
                <button className="link" onClick={() => setShowImages(true)}>이미지 표시</button>
              </div>
            )}
            {msg.attachments.length > 0 && (
              <section className="mail-attaches">
                <h4 className="small">첨부파일 {msg.attachments.length}개</h4>
                <div className="mail-attach-grid">
                  {msg.attachments.map((a) => {
                    const ic = fileIcon(a.name, a.type);
                    return (
                      <div key={a.part || a.name} className="mail-attach">
                        <span className="mail-attach-ic" style={{ background: ic.color }}>{ic.label}</span>
                        <div className="mail-attach-body">
                          <div className="ellipsis" title={a.name}>{a.name}</div>
                          <div className="muted tiny">{a.sizeLabel}</div>
                        </div>
                        <button className="icon-btn" title="웹 메일에서 내려받기" onClick={() => open(mailUrl(msg.folder, String(msg.uid)))}><Icon name="download" size={15} /></button>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
            <div className="mail-body-wrap"><MailBody key={`${msg.uid}/${showImages}`} html={body.html} /></div>
          </article>
        )}
      </section>
    </div>
  );
}
