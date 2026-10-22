import { useState } from "react";
import { api, type SessionUser, type Settings } from "../api";

export function Login({ settings, onLoggedIn }: { settings: Settings; onLoggedIn: (u: SessionUser) => void }) {
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [username, setUsername] = useState(settings.username);
  const [password, setPassword] = useState("");
  const [rememberMe, setRemember] = useState(settings.rememberMe);
  const [autoLogin, setAuto] = useState(settings.autoLogin);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const canUseSaved = settings.hasSavedPassword && username === settings.username;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return setErr("아이디를 입력하세요");
    if (!password && !canUseSaved) return setErr("비밀번호를 입력하세요");
    setBusy(true);
    setErr("");
    try {
      const u = await api().call<SessionUser>("auth:login", {
        serverUrl, username, password: password || undefined, rememberMe, autoLogin,
      });
      onLoggedIn(u);
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
        <div className="logo-mark big">U</div>
        <h1>UBION Messenger</h1>
        <p className="muted">회사 계정으로 로그인하세요</p>
        <label>
          아이디
          <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} />
        </label>
        <label>
          비밀번호
          <input
            type="password"
            value={password}
            placeholder={canUseSaved ? "저장된 비밀번호 사용" : ""}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {advanced ? (
          <label>
            서버 주소
            <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} spellCheck={false} />
          </label>
        ) : (
          <button type="button" className="link small" onClick={() => setAdvanced(true)}>
            서버: {serverUrl.replace(/^https?:\/\//, "")} · 변경
          </button>
        )}
        <div className="checks">
          <label className="check">
            <input type="checkbox" checked={rememberMe} onChange={(e) => { setRemember(e.target.checked); if (!e.target.checked) setAuto(false); }} />
            로그인 정보 저장
          </label>
          <label className={`check ${rememberMe ? "" : "disabled"}`}>
            <input type="checkbox" disabled={!rememberMe} checked={autoLogin} onChange={(e) => setAuto(e.target.checked)} />
            자동 로그인
          </label>
        </div>
        {err && <div className="form-error">{err}</div>}
        <button className="primary" disabled={busy}>{busy ? "로그인 중…" : "로그인"}</button>
        <p className="muted tiny">비밀번호는 OS 보안 저장소(Keychain/DPAPI)에 암호화되어 저장됩니다.</p>
      </form>
    </div>
  );
}
