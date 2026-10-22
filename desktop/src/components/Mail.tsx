import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "./ui";
import type { MailFolder, MailFolders } from "../../electron/core/portal";

const open = (url: string) => void api().portal.open(url).catch(() => undefined);

function FolderList({ title, folders, onOpen }: { title?: string; folders: MailFolder[]; onOpen: (f: MailFolder) => void }) {
  if (!folders.length) return null;
  return (
    <section className="mail-group">
      {title && <h4 className="muted small">{title}</h4>}
      {folders.map((f) => (
        <button key={`${f.id}/${f.encName}`} className="mail-folder" style={{ paddingLeft: 12 + f.depth * 14 }} onClick={() => onOpen(f)}>
          <Icon name="mail" size={16} />
          <span className="ellipsis">{f.name}</span>
          {f.unseenCnt > 0 && <span className="badge">{f.unseenCnt > 99 ? "99+" : f.unseenCnt}</span>}
          <span className="muted small mail-total">{f.totalCnt}</span>
        </button>
      ))}
    </section>
  );
}

export function Mail() {
  const [data, setData] = useState<MailFolders | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      setData(await api().portal.mailFolders());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The web mail app keeps the folder in history state, not the URL, so the portal window always opens at 받은메일함.
  const openFolder = (_f: MailFolder) => open("/app/mail");
  const search = (e: React.FormEvent) => {
    e.preventDefault();
    const k = q.trim();
    if (!k) return;
    open(`/app/unified/search?stype=simple&searchTerm=mail&offset=5&page=0&keyword=${encodeURIComponent(k)}`);
  };
  const percent = data ? Math.max(0, Math.min(100, data.quota.percent)) : 0;

  return (
    <div className="mail-view">
      <div className="side-head home-head">
        <h2>메일</h2>
        <button className="primary small" onClick={() => open("/app/mail?work=write")}>
          <Icon name="plus" size={15} /> 메일 쓰기
        </button>
        <button className={`icon-btn ${loading ? "spin" : ""}`} title="새로고침" onClick={() => void load()}>
          <Icon name="refresh" size={18} />
        </button>
      </div>
      <form className="search-box mail-search" onSubmit={search}>
        <Icon name="search" size={16} />
        <input placeholder="메일 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="link" type="submit" disabled={!q.trim()}>검색</button>
      </form>
      <p className="muted tiny mail-note">메일 목록/본문은 서버가 POST 전용이라 포털 창에서 열립니다.</p>
      {err && (
        <div className="mail-error">
          <span>{err}</span>
          <button className="link" onClick={() => void load()}>다시 시도</button>
        </div>
      )}
      {loading && !data && <div className="muted small pad">불러오는 중…</div>}
      {data && (
        <>
          <section className="mail-quota">
            <div className="mail-quota-top">
              <span>용량</span>
              <span className="muted small">{percent}%{data.quota.usageUnit || data.quota.limitUnit ? ` · ${data.quota.usageUnit} / ${data.quota.limitUnit}` : ""}</span>
            </div>
            <div className="mail-quota-bar"><i style={{ width: `${percent}%` }} /></div>
          </section>
          <div className="mail-folders">
            <FolderList folders={data.defaultFolders} onOpen={openFolder} />
            <FolderList title="내 폴더" folders={data.userFolders} onOpen={openFolder} />
            <FolderList title="공유 폴더" folders={data.userSharedFolders} onOpen={openFolder} />
            {!data.defaultFolders.length && !data.userFolders.length && !data.userSharedFolders.length && (
              <div className="muted small pad">메일함이 없습니다</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
