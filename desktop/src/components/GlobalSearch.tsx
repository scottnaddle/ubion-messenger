import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type Person, type Room } from "../api";
import { Icon } from "./ui";
import { useT } from "../lib/i18n";
import { dayLabel, fileSize, timeLabel } from "../lib/format";
import {
  groupHitsByRoom, mergeHits, type GlobalSearchCaps, type GlobalSearchQuery, type SearchHit,
} from "../lib/global-search";

type Chip = "person" | "date" | null;

let nextSearchId = 1;

/** 통합 검색: every room, local cache first then the server (throttled, recent rooms first). */
export function GlobalSearch({
  rooms, initialKeyword = "", onOpenRoom, onClose,
}: {
  rooms: Room[]; initialKeyword?: string; onOpenRoom: (key: string) => void; onClose: () => void;
}) {
  const t = useT();
  const [keyword, setKeyword] = useState(initialKeyword);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sender, setSender] = useState<Person | null>(null);
  const [files, setFiles] = useState(false);
  const [chip, setChip] = useState<Chip>(null);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [personQ, setPersonQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [progress, setProgress] = useState<{ searched: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [caps, setCaps] = useState<GlobalSearchCaps | null>(null);
  const current = useRef(0);

  useEffect(() => {
    api().search.caps().then(setCaps).catch(() => undefined);
    if (initialKeyword.trim()) void run();
    const off = api().search.onProgress((p) => {
      if (p.searchId !== current.current) return;
      if (p.hits.length) setHits((h) => mergeHits(h || [], p.hits));
      if (p.phase !== "local") setProgress({ searched: p.searchedRooms, total: p.totalRooms });
    });
    return () => {
      off();
      if (current.current) void api().search.cancel().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (chip !== "person" || people) return;
    api().call<Person[]>("org:users").then(setPeople).catch(() => setPeople([]));
  }, [chip, people]);

  const roomName = useMemo(() => new Map(rooms.map((r) => [r.key, r.name])), [rooms]);
  const personMatches = useMemo(() => {
    const q = personQ.trim().toLowerCase();
    return (people || []).filter((p) => !q || p.name.toLowerCase().includes(q)).slice(0, 8);
  }, [people, personQ]);

  const run = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const query: GlobalSearchQuery = {
      keyword: keyword.trim() || undefined,
      from: from || undefined,
      to: to || undefined,
      senderSeq: sender?.userId,
      files: files ? "file" : undefined,
    };
    if (!query.keyword && !query.from && !query.to && query.senderSeq == null && !query.files) return;
    const id = nextSearchId++;
    current.current = id;
    setHits([]);
    setProgress(null);
    setNote("");
    setBusy(true);
    try {
      const res = await api().search.global(id, query);
      if (current.current !== id) return;
      setHits((h) => mergeHits(h || [], res.hits));
      setProgress({ searched: res.searchedRooms, total: res.totalRooms });
      if (!res.serverSearched) setNote(t("서버 검색 없이 이 PC에 저장된 대화에서만 찾았습니다"));
      else if (res.failedRooms) setNote(t("{n}개 대화방은 검색하지 못했습니다", { n: res.failedRooms }));
    } catch (err) {
      if (current.current === id) setNote((err as Error).message);
    } finally {
      if (current.current === id) setBusy(false);
    }
  };

  const cancel = () => {
    void api().search.cancel().catch(() => undefined);
    current.current = 0;
    setBusy(false);
    setNote(t("검색을 취소했습니다"));
  };

  const groups = hits ? groupHitsByRoom(hits) : [];
  const dateLabel = from || to ? (from && to && from !== to ? `${from} ~ ${to}` : from || to) : t("기간");

  return createPortal(
    <div className="modal-back" onClick={onClose}>
      <div className="modal gsearch-modal" role="dialog" aria-modal="true" aria-label={t("전체 대화 검색")} onClick={(e) => e.stopPropagation()}>
        <div className="side-head">
          <h3>{t("전체 대화 검색")}</h3>
          <button className="icon-btn" title={t("닫기")} onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
        <form className="search-box" onSubmit={run}>
          <Icon name="search" size={16} />
          <input
            autoFocus
            placeholder={files ? t("파일 이름 검색") : t("검색어 입력 후 Enter")}
            value={keyword}
            maxLength={100}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
          />
        </form>
        <div className="chips">
          <button type="button" className={`chip ${sender ? "on" : ""}`} onClick={() => setChip(chip === "person" ? null : "person")}>
            {sender ? sender.name : t("사람")}
          </button>
          <button type="button" className={`chip ${from || to ? "on" : ""}`} onClick={() => setChip(chip === "date" ? null : "date")}>
            {dateLabel}
          </button>
          <button type="button" className={`chip ${files ? "on" : ""}`} onClick={() => setFiles((f) => !f)}>
            {t("파일")}
          </button>
        </div>
        {chip === "person" && (
          <div className="gsearch-filter">
            <input placeholder={t("이름으로 찾기")} value={personQ} onChange={(e) => setPersonQ(e.target.value)} />
            {sender && <button className="link" onClick={() => { setSender(null); setChip(null); }}>{t("선택 해제")}</button>}
            <div className="gsearch-people">
              {people == null && <div className="muted small">{t("불러오는 중…")}</div>}
              {personMatches.map((p) => (
                <button key={p.userId} className="gsearch-person" onClick={() => { setSender(p); setChip(null); }}>
                  {p.name} <span className="muted tiny">{p.position}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {chip === "date" && (
          <div className="gsearch-filter">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t("시작일")} />
            <span className="muted">~</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t("종료일")} />
            {(from || to) && <button className="link" onClick={() => { setFrom(""); setTo(""); }}>{t("선택 해제")}</button>}
            {caps && !caps.dateRange && <div className="muted tiny">{t("여러 날짜를 고르면 서버에는 검색어·사람 조건만 보내고 기간은 이 PC에서 거릅니다")}</div>}
          </div>
        )}
        <div className="gsearch-status muted small">
          {busy && (
            <>
              {progress?.total ? t("대화방 {n}/{total} 검색 중…", { n: progress.searched, total: progress.total }) : t("검색 중…")}{" "}
              <button className="link" onClick={cancel}>{t("취소")}</button>
            </>
          )}
          {!busy && note}
        </div>
        <div className="modal-body search-results">
          {hits && !busy && !hits.length && <div className="muted small pad">{t("결과 없음")}</div>}
          {groups.map((g) => (
            <div key={g.roomKey} className="gsearch-group">
              <div className="gsearch-room">{roomName.get(g.roomKey) || t("알 수 없는 대화방")} <span className="muted tiny">{g.hits.length}</span></div>
              {g.hits.map((h) => (
                <button
                  key={h.messageId}
                  className="search-hit gsearch-hit"
                  onClick={() => {
                    onOpenRoom(h.roomKey);
                    onClose();
                  }}
                >
                  <div className="small"><b>{h.sendUserName}</b> <span className="muted tiny">{dayLabel(h.createdAt)} {timeLabel(h.createdAt)}</span></div>
                  {h.attach ? (
                    <div className="small hit-text">📎 {h.attach.name}{h.attach.size ? ` · ${fileSize(h.attach.size)}` : ""}</div>
                  ) : null}
                  {h.message && <div className="small hit-text">{h.message}</div>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
