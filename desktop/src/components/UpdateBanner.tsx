import { useEffect, useState } from "react";
import { api, type UpdateStatus } from "../api";
import { useT } from "../lib/i18n";

export function useUpdateStatus() {
  const [s, setS] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    api().call<UpdateStatus>("update:status").then(setS).catch(() => undefined);
    return api().onUpdate((n) => setS((p) => ({ ...p, ...n })));
  }, []);
  return s;
}

/** Top banner: Windows → "새 버전 설치 후 다시 시작"; macOS → download dmg + drag-to-Applications guide. */
export function UpdateBanner() {
  const t = useT();
  const s = useUpdateStatus();
  const [hidden, setHidden] = useState<string | null>(null);
  const mac = api().platform === "darwin";
  if (!s || !s.version || hidden === `${s.state}:${s.version}`) return null;
  if (s.state === "available" && mac)
    return (
      <div className="banner info">
        {t("새 버전 {version}이(가) 있습니다.", { version: s.version })}
        <button className="link" onClick={() => api().call("update:download")}>{t("다운로드")}</button>
        <button className="link muted" onClick={() => api().call("update:openPage")}>{t("변경 내역")}</button>
        <button className="link muted" onClick={() => setHidden(`${s.state}:${s.version}`)}>{t("나중에")}</button>
      </div>
    );
  if (s.state === "downloading" && mac)
    return <div className="banner info">{t("새 버전 {version} 다운로드 중… {percent}%", { version: s.version, percent: s.percent ?? 0 })}</div>;
  if (s.state === "downloaded" && mac)
    return (
      <div className="banner info">
        {t("{version} 설치 파일을 열었습니다: 창에서 UBION Messenger를 응용 프로그램 폴더로 끌어 놓고 ‘대치’를 선택한 뒤, 이 앱을 종료하고 다시 실행하세요.", { version: s.version })}
        <button className="link" onClick={() => api().call("update:install")}>{t("설치 파일 다시 열기")}</button>
        <button className="link muted" onClick={() => setHidden(`${s.state}:${s.version}`)}>{t("닫기")}</button>
      </div>
    );
  if (s.state === "downloaded")
    return (
      <div className="banner info">
        {t("새 버전 {version}이(가) 준비되었습니다.", { version: s.version })}
        <button className="primary small" onClick={() => api().call("update:install")}>{t("새 버전 설치 후 다시 시작")}</button>
        <button className="link muted" onClick={() => setHidden(`${s.state}:${s.version}`)}>{t("종료할 때 설치")}</button>
      </div>
    );
  return null;
}
