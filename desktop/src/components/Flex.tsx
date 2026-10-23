import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { FLEX_INBOX } from "../../electron/core/flex";
import { Icon } from "./ui";

const Webview: any = "webview";

export function Flex() {
  const ref = useRef<any>(null);
  const [url, setUrl] = useState(FLEX_INBOX);
  const [pending, setPending] = useState<number | null>(null);

  const refreshPending = () => {
    api().portal.flexPending(true).then((r) => setPending(r.count)).catch(() => setPending(null));
  };

  useEffect(() => {
    refreshPending();
    const wv = ref.current;
    if (!wv) return;
    const onNav = () => {
      try {
        setUrl(wv.getURL() || FLEX_INBOX);
      } catch {
        /* webview not ready */
      }
      refreshPending();
    };
    const events = ["did-navigate", "did-navigate-in-page", "did-finish-load"];
    events.forEach((e) => wv.addEventListener(e, onNav));
    return () => events.forEach((e) => wv.removeEventListener(e, onNav));
  }, []);

  const goBack = () => ref.current?.goBack?.();
  const goForward = () => ref.current?.goForward?.();
  const reload = () => ref.current?.reload?.();
  const openExternal = () => {
    if (/^https?:\/\//i.test(url)) void api().call("app:openExternal", url).catch(() => undefined);
  };

  return (
    <div className="flex-view">
      <div className="side-head home-head flex-head">
        <h2>플렉스</h2>
        <span className="muted small">
          {pending == null ? "승인 대기 확인 중/불가" : `승인 대기 ${pending}건`}
        </span>
        <button className="icon-btn" title="새로고침" onClick={refreshPending}><Icon name="refresh" size={18} /></button>
      </div>
      <div className="flex-toolbar">
        <button className="icon-btn" title="뒤로" onClick={goBack}>◀</button>
        <button className="icon-btn" title="앞으로" onClick={goForward}>▶</button>
        <button className="icon-btn" title="새로고침" onClick={reload}><Icon name="refresh" size={18} /></button>
        <button className="icon-btn" title="외부 브라우저로 열기" onClick={openExternal}><Icon name="external" size={18} /></button>
        <div className="grow" />
        {pending != null && pending > 0 && <span className="badge">{pending > 99 ? "99+" : pending}</span>}
      </div>
      <Webview
        ref={ref}
        className="flex-webview"
        src={FLEX_INBOX}
        partition="persist:portal"
        allowpopups="true"
      />
    </div>
  );
}
