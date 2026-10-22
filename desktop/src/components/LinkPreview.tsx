import { useEffect, useState } from "react";
import { api } from "../api";
import { URL_RE } from "../lib/format";
import type { LinkPreview as LP } from "../../electron/core/types";

const cache = new Map<string, Promise<LP | null>>();
const imgCache = new Map<string, Promise<string | null>>();
const load = (url: string) => {
  if (!cache.has(url)) cache.set(url, api().call<LP | null>("link:preview", url).catch(() => null));
  return cache.get(url)!;
};
const loadImg = (url: string) => {
  if (!imgCache.has(url)) imgCache.set(url, api().call<string | null>("link:image", url).catch(() => null));
  return imgCache.get(url)!;
};

export function firstUrl(text: string): string | null {
  const m = text.match(new RegExp(URL_RE.source));
  return m ? m[1].replace(/[),.;:!?」』]+$/, "") : null;
}

/** Compact OpenGraph card under a message containing a URL. */
export function LinkPreview({ text }: { text: string }) {
  const url = firstUrl(text);
  const [p, setP] = useState<LP | null>(null);
  const [img, setImg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setP(null); setImg(null);
    if (!url) return;
    load(url).then((r) => {
      if (!live || !r) return;
      setP(r);
      if (r.image && !r.internal) loadImg(r.image).then((d) => live && setImg(d));
    });
    return () => { live = false; };
  }, [url]);
  if (!url || !p) return null;
  return (
    <button className={`link-card ${p.internal ? "internal" : ""}`} onClick={() => api().call("app:openExternal", p.url)} title={p.url}>
      <div className="lc-text">
        <div className="lc-site tiny">{p.siteName}</div>
        {p.title && <div className="lc-title">{p.title}</div>}
        {p.description && <div className="lc-desc tiny">{p.description}</div>}
      </div>
      {img && <img className="lc-img" src={img} alt="" />}
    </button>
  );
}
