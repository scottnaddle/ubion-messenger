import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "./ui";

export type WizardHit = {
  id: string;
  title: string;
  subtitle?: string;
  url: string;
  target: "portal" | "external" | "local";
  local?: string;
  appName?: string;
  score: number;
  reason: string;
  pinned: boolean;
  usage: number;
  lastUsedAt?: number;
  source: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onLocal: (v: string) => void;
  toast: (m: string, k?: "info" | "error") => void;
};

export function Wizard({ open, onClose, onLocal, toast }: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<WizardHit[]>([]);
  const [sel, setSel] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    setLoading(true);
    api()
      .call("wizard:refresh")
      .catch(() => undefined)
      .finally(() => {
        void api()
          .call<WizardHit[]>("wizard:search", "")
          .then((h) => {
            setHits(h);
            setLoading(false);
          })
          .catch(() => setLoading(false));
      });
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const h = setTimeout(() => {
      api()
        .call<WizardHit[]>("wizard:search", q)
        .then((list) => {
          setHits(list);
          setSel(0);
        })
        .catch(() => undefined);
    }, 80);
    return () => clearTimeout(h);
  }, [q, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => Math.min(hits.length - 1, s + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => Math.max(0, s - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const hit = hits[sel];
        if (hit) void openHit(hit);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, hits, sel]);

  const openHit = async (hit: WizardHit) => {
    try {
      await api().call("wizard:open", hit.id);
      if (hit.target === "local" && hit.local) {
        onLocal(hit.local);
      } else if (hit.appName === "mail" || hit.appName === "approval" || hit.local === "mail" || hit.local === "approval") {
        onLocal(hit.appName === "mail" || hit.local === "mail" ? "mail" : "approval");
      } else if (hit.url) {
        // Always open portal pages in-app (SSO) — never submit forms
        await api().portal.open(hit.url, hit.target === "external" ? "external" : "inapp");
      }
      toast(`${hit.title} 열기`, "info");
      onClose();
    } catch (e) {
      toast((e as Error).message || "열지 못했습니다", "error");
    }
  };

  if (!open) return null;

  return (
    <div className="modal-back wizard-back" onClick={onClose}>
      <div className="wizard" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="위저드">
        <div className="wizard-head">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="명함, 법인 차량, 회의실 예약… (초성 가능)"
            aria-label="위저드 검색"
          />
          <kbd className="muted tiny">esc</kbd>
        </div>
        <div className="wizard-hint muted tiny">
          회사 신청·예약 페이지로 바로 이동합니다. 제출은 하지 않습니다. ⌘/Ctrl+K
        </div>
        <ul className="wizard-list">
          {loading && <li className="muted">불러오는 중…</li>}
          {!loading && hits.length === 0 && <li className="muted">결과 없음</li>}
          {hits.map((h, i) => (
            <li key={h.id} className={i === sel ? "on" : ""}>
              <button className="wizard-item" onClick={() => void openHit(h)} onMouseEnter={() => setSel(i)}>
                <span className="wizard-ic">
                  <Icon name={h.appName === "works" ? "briefcase" : h.appName === "asset" ? "door" : h.appName === "approval" ? "approval" : /차량/.test(h.title) ? "car" : "link"} size={18} />
                </span>
                <span className="grow">
                  <span className="wizard-title">
                    {h.title}
                    {h.pinned && <span className="pill tiny">고정</span>}
                    {!h.pinned && !!h.lastUsedAt && <span className="pill tiny">최근</span>}
                  </span>
                  <span className="muted tiny">
                    {h.subtitle || h.appName} · {h.source}
                    {h.usage ? ` · ${h.usage}회` : ""}
                  </span>
                </span>
                <button
                  className="icon-btn"
                  title={h.pinned ? "고정 해제" : "고정"}
                  onClick={async (e) => {
                    e.stopPropagation();
                    await api().call("wizard:pin", h.id, !h.pinned);
                    setHits(await api().call("wizard:search", q));
                  }}
                >
                  <Icon name="pin" size={14} />
                </button>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
