import { useState } from "react";
import { api, type SessionUser, type Settings } from "../api";
import { flavorLabel, flavorProfile, normalizeServerUrl } from "../../electron/core/flavor";
import { getLanguage, useT } from "../lib/i18n";

type WebNeeded = { webLoginRequired: true; message: string };
const isWebNeeded = (r: unknown): r is WebNeeded => !!r && typeof r === "object" && (r as any).webLoginRequired === true;

export function Login({ settings, onLoggedIn, webPrompt }: { settings: Settings; onLoggedIn: (u: SessionUser) => void; webPrompt?: string }) {
  const t = useT();
  const profile = flavorProfile();
  const brand = flavorLabel(profile, getLanguage());
  const serverFirst = profile.serverUrlFirstClass;
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [username, setUsername] = useState(settings.username);
  const [password, setPassword] = useState("");
  const [rememberMe, setRemember] = useState(settings.rememberMe);
  const [autoLogin, setAuto] = useState(settings.autoLogin);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [webMsg, setWebMsg] = useState(webPrompt || "");

  const checkedUrl = (): string | null => {
    try {
      return normalizeServerUrl(serverUrl);
    } catch (e) {
      setErr(t((e as Error).message));
      return null;
    }
  };

  /** Opens the server's own login page (ID/PW/OTP typed there, never seen by the app). */
  const webLogin = async () => {
    if (!checkedUrl()) return;
    setBusy(true);
    setErr("");
    try {
      const u = await api().call<SessionUser | null>("auth:webLogin", { serverUrl });
      if (u) onLoggedIn(u);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const canUseSaved = settings.hasSavedPassword && username === settings.username;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!checkedUrl()) return;
    if (!username.trim()) return setErr(t("아이디를 입력하세요"));
    if (!password && !canUseSaved) return setErr(t("비밀번호를 입력하세요"));
    setBusy(true);
    setErr("");
    try {
      const r = await api().call<SessionUser | WebNeeded>("auth:login", {
        serverUrl, username, password: password || undefined, rememberMe, autoLogin,
      });
      if (isWebNeeded(r)) setWebMsg(r.message.split("\n")[0]);
      else onLoggedIn(r);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-drag" />
      <form className="login-card" onSubmit={submit}>
        <div className={`logo-mark big${profile.logoClass ? ` ${profile.logoClass}` : ""}`}>{profile.logoMark}</div>
        <h1>{brand}</h1>
        <p className="muted">{t("회사 계정으로 로그인하세요")}</p>
        {profile.unofficialNotice ? <p className="muted tiny disclaimer">{profile.unofficialNotice}</p> : null}
        {serverFirst && (
          <label>
            {t("서버 주소")}
            <input
              autoFocus={!serverUrl}
              value={serverUrl}
              placeholder="https://"
              onChange={(e) => setServerUrl(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>
        )}
        {serverFirst && !serverUrl.trim() ? <p className="muted tiny">{t("회사 메신저 서버 주소를 입력하세요")}</p> : null}
        <label>
          {t("아이디")}
          <input autoFocus={!serverFirst || !!serverUrl.trim()} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} />
        </label>
        <label>
          {t("비밀번호")}
          <input
            type="password"
            value={password}
            placeholder={canUseSaved ? t("저장된 비밀번호 사용") : ""}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {!serverFirst && (advanced ? (
          <label>
            {t("서버 주소")}
            <input
              value={serverUrl}
              placeholder="https://"
              onChange={(e) => setServerUrl(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>
        ) : (
          <button type="button" className="link small" onClick={() => setAdvanced(true)}>
            {t("서버: {server} · 변경", { server: serverUrl.replace(/^https?:\/\//, "") })}
          </button>
        ))}
        <div className="checks">
          <label className="check">
            <input type="checkbox" checked={rememberMe} onChange={(e) => { setRemember(e.target.checked); if (!e.target.checked) setAuto(false); }} />
            {t("로그인 정보 저장")}
          </label>
          <label className={`check ${rememberMe ? "" : "disabled"}`}>
            <input type="checkbox" disabled={!rememberMe} checked={autoLogin} onChange={(e) => setAuto(e.target.checked)} />
            {t("자동 로그인")}
          </label>
        </div>
        {err && <div className="form-error">{err}</div>}
        {webMsg ? (
          <div className="form-error web-login-box">
            <div>{webMsg}</div>
            <button type="button" className="primary" disabled={busy} onClick={webLogin}>{t("웹에서 인증하고 로그인")}</button>
          </div>
        ) : null}
        <button className="primary" disabled={busy}>{busy ? t("로그인 중…") : t("로그인")}</button>
        <button type="button" className="link small" disabled={busy} onClick={webLogin}>{t("웹 로그인으로 접속")}</button>
        <p className="muted tiny">{t("비밀번호는 OS 보안 저장소(Keychain/DPAPI)에 암호화되어 저장됩니다.")}</p>
      </form>
    </div>
  );
}
