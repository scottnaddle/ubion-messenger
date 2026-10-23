import { useEffect, useState } from "react";
import { api, type LockStatus, type SessionUser, type Settings } from "../api";
import { Avatar, Icon } from "./ui";
import { useUpdateStatus } from "./UpdateBanner";
import { THEME_MAX_BYTES, THEME_PRESETS, type ThemeState } from "../../electron/core/theme";

export function SettingsModal({
  settings, user, onChange, onClose, onLogout,
}: { settings: Settings; user: SessionUser; onChange: (s: Settings) => void; onClose: () => void; onLogout: () => void }) {
  const [info, setInfo] = useState<{ version: string; platform: string; encryption: boolean } | null>(null);
  const [lock, setLock] = useState<LockStatus | null>(null);
  const [lockCurrentPin, setLockCurrentPin] = useState("");
  const [lockNewPin, setLockNewPin] = useState("");
  const [lockConfirmPin, setLockConfirmPin] = useState("");
  const [lockError, setLockError] = useState("");
  const [lockBusy, setLockBusy] = useState(false);
  const [themeMsg, setThemeMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [themeBusy, setThemeBusy] = useState(false);
  useEffect(() => {
    api().call("app:info").then(setInfo).catch(() => undefined);
    api().call<LockStatus>("lock:status").then(setLock).catch(() => undefined);
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const set = async (patch: Partial<Settings>) => {
    onChange({ ...settings, ...patch });
    onChange(await api().call<Settings>("settings:set", patch));
  };

  const applyThemeState = (st: ThemeState) => onChange({ ...settings, customThemes: st.themes, activeThemeId: st.activeThemeId });
  const themeOp = async (fn: () => Promise<string | void>) => {
    setThemeMsg(null);
    setThemeBusy(true);
    try {
      const text = await fn();
      if (text) setThemeMsg({ text });
    } catch (e) {
      setThemeMsg({ text: (e as Error).message, error: true });
    } finally {
      setThemeBusy(false);
    }
  };
  const importTheme = () => themeOp(async () => {
    const r = await api().theme.import();
    if (!r) return;
    applyThemeState(await api().theme.activate(r.id));
    return r.removed.length ? `가져왔습니다. 안전하지 않은 항목을 제거했습니다: ${r.removed.join(", ")}` : "가져와서 적용했습니다.";
  });

  const refreshLock = async () => {
    try {
      setLock(await api().call<LockStatus>("lock:status"));
    } catch {
      /* status is best effort */
    }
  };
  const lockUnsupported = !!info && !info.encryption;
  const saveLockPin = async () => {
    setLockError("");
    if (lockNewPin !== lockConfirmPin) {
      setLockError("PIN이 일치하지 않습니다.");
      return;
    }
    if (!/^\d{4,12}$/.test(lockNewPin)) {
      setLockError("PIN은 4~12자리 숫자입니다.");
      return;
    }
    setLockBusy(true);
    try {
      await api().call("lock:setPin", lockNewPin, lock?.enabled ? lockCurrentPin : undefined);
      setLockCurrentPin("");
      setLockNewPin("");
      setLockConfirmPin("");
      await refreshLock();
    } catch (e) {
      setLockError((e as Error).message);
    } finally {
      setLockBusy(false);
    }
  };
  const disableLock = async () => {
    setLockError("");
    if (!lockCurrentPin) {
      setLockError("현재 PIN을 입력하세요.");
      return;
    }
    setLockBusy(true);
    try {
      await api().call("lock:disable", lockCurrentPin);
      setLockCurrentPin("");
      setLockNewPin("");
      setLockConfirmPin("");
      await refreshLock();
    } catch (e) {
      setLockError((e as Error).message);
    } finally {
      setLockBusy(false);
    }
  };

  const Toggle = ({ k, label, desc, disabled }: { k: keyof Settings; label: string; desc?: string; disabled?: boolean }) => (
    <label className={`row ${disabled ? "disabled" : ""}`}>
      <div>
        <div>{label}</div>
        {desc && <div className="muted tiny">{desc}</div>}
      </div>
      <input type="checkbox" className="switch" disabled={disabled} checked={!!settings[k]} onChange={(e) => set({ [k]: e.target.checked } as Partial<Settings>)} />
    </label>
  );

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="side-head">
          <h2>설정</h2>
          <button className="icon-btn" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="modal-body">
          <section className="me-card">
            <Avatar name={user.name} src={user.thumbnail} size={48} />
            <div className="grow">
              <div className="name">{user.name}</div>
              <div className="muted small">{user.loginId} · {settings.serverUrl.replace(/^https?:\/\//, "")}</div>
            </div>
            <button className="danger-btn" onClick={onLogout}>로그아웃</button>
          </section>
          <h4>화면</h4>
          <div className="row">
            <div>테마</div>
            <div className="seg">
              {(["system", "light", "dark"] as const).map((t) => (
                <button key={t} className={settings.theme === t ? "on" : ""} onClick={() => set({ theme: t })}>
                  {{ system: "시스템", light: "라이트", dark: "다크" }[t]}
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <div>색상</div>
            <div className="theme-presets">
              {THEME_PRESETS.map((p) => (
                <button key={p.id} className={(settings.themePreset || "default") === p.id ? "on" : ""} title={p.name} onClick={() => set({ themePreset: p.id })}>
                  <span className="swatch" style={{ background: p.swatch }} />{p.name}
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <div>
              <div>사용자 테마</div>
              <div className="muted tiny">CSS 파일({THEME_MAX_BYTES / 1024}KB 이하)을 가져와 화면에 덧씌웁니다. 외부 URL·@import·스크립트는 제거됩니다.</div>
            </div>
            <button className="link small" disabled={themeBusy} onClick={() => void importTheme()}>CSS 가져오기…</button>
          </div>
          {(settings.customThemes || []).length > 0 && (
            <div className="theme-list">
              <div className="row">
                <label className="theme-name">
                  <input type="radio" name="custom-theme" checked={!settings.activeThemeId} disabled={themeBusy}
                    onChange={() => void themeOp(async () => applyThemeState(await api().theme.activate(null)))} />
                  <span>사용 안 함</span>
                </label>
              </div>
              {settings.customThemes!.map((t) => (
                <div className="row" key={t.id}>
                  <label className="theme-name">
                    <input type="radio" name="custom-theme" checked={settings.activeThemeId === t.id} disabled={themeBusy}
                      onChange={() => void themeOp(async () => applyThemeState(await api().theme.activate(t.id)))} />
                    <span>{t.name}</span>
                  </label>
                  <button className="link small danger" disabled={themeBusy}
                    onClick={() => void themeOp(async () => applyThemeState(await api().theme.remove(t.id)))}>삭제</button>
                </div>
              ))}
            </div>
          )}
          {themeMsg && <div className={themeMsg.error ? "lock-error" : "muted tiny"}>{themeMsg.text}</div>}
          <div className="row">
            <div>글자 크기</div>
            <input type="range" min={12} max={18} value={settings.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} />
          </div>
          <h4>알림</h4>
          <Toggle k="notifications" label="데스크톱 알림" />
          <Toggle k="notificationPreview" label="알림에 메시지 내용 표시" disabled={!settings.notifications} />
          <Toggle k="notificationSound" label="알림 소리" disabled={!settings.notifications} />
          <Toggle k="portalPostNotify" label="전사게시판 새 글 알림" desc="홈 탭: 새 전사 공지를 데스크톱 알림으로 표시" disabled={!settings.notifications} />
          <div className="row">
            <div>
              <div>포털(홈) 링크 열기</div>
              <div className="muted small">앱 안 창: 메신저 로그인 그대로 사용(재로그인 불필요) · 외부 브라우저: 웹 로그인이 필요할 수 있음</div>
            </div>
            <select value={settings.portalOpenMode} onChange={(e) => set({ portalOpenMode: e.target.value as "inapp" | "external", portalOpenModeChosen: true })}>
              <option value="inapp">앱 안 창 (자동 로그인)</option>
              <option value="external">외부 브라우저</option>
            </select>
          </div>
          <h4>부재 설정</h4>
          <div className="row">
            <div>
              <div>PC 메신저 부재 설정</div>
              <div className="muted tiny">※ 설정한 시간 동안 PC를 사용하지 않으면 모바일 앱으로 알림을 전송하며 자리비움 상태로 전환합니다.</div>
            </div>
            <select value={settings.awayMinutes} onChange={(e) => set({ awayMinutes: Number(e.target.value) as Settings["awayMinutes"] })}>
              <option value={1}>1분 후</option>
              <option value={5}>5분 후</option>
              <option value={10}>10분 후</option>
              <option value={15}>15분 후</option>
              <option value={0}>설정 안 함</option>
            </select>
          </div>
          <Toggle k="mobileNotice" label="PC 미사용 시 모바일로 알림" desc="자리비움 상태가 되면 모바일 앱으로 알림을 전송합니다 (모바일 푸시 동작은 서버 정책에 따름)" />
          <h4>메신저 잠금</h4>
          <div className="row">
            <div>
              <div>자동 잠금</div>
              <div className="muted tiny">설정한 시간 동안 PC를 사용하지 않으면 메신저를 잠급니다.</div>
            </div>
            <select value={settings.lockTimeoutMin} onChange={(e) => set({ lockTimeoutMin: Number(e.target.value) as Settings["lockTimeoutMin"] })}>
              <option value={0}>사용 안 함</option>
              <option value={1}>1분 후</option>
              <option value={5}>5분 후</option>
              <option value={10}>10분 후</option>
              <option value={30}>30분 후</option>
              <option value={60}>60분 후</option>
            </select>
          </div>
          {lockUnsupported ? (
            <div className="muted tiny">OS 보안 저장소를 사용할 수 없어 잠금을 설정할 수 없습니다.</div>
          ) : (
            <>
              {lock?.enabled && (
                <div className="row">
                  <div>현재 PIN</div>
                  <input type="password" inputMode="numeric" autoComplete="off" value={lockCurrentPin} onChange={(e) => setLockCurrentPin(e.target.value)} />
                </div>
              )}
              <div className="row">
                <div>{lock?.enabled ? "새 PIN" : "PIN"}</div>
                <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={lockNewPin} onChange={(e) => setLockNewPin(e.target.value.replace(/\D/g, ""))} />
              </div>
              <div className="row">
                <div>{lock?.enabled ? "새 PIN 확인" : "PIN 확인"}</div>
                <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={lockConfirmPin} onChange={(e) => setLockConfirmPin(e.target.value.replace(/\D/g, ""))} />
              </div>
              <div className="row">
                <div className="muted tiny">{lock?.enabled ? "PIN을 변경하거나 잠금을 해제할 수 있습니다." : "PIN을 설정하면 앱 시작 시 잠금 화면이 표시됩니다."}</div>
                <div className="row-actions">
                  <button className="primary small" disabled={lockBusy} onClick={() => void saveLockPin()}>{lock?.enabled ? "PIN 변경" : "잠금 설정"}</button>
                  {lock?.enabled && <button className="danger-btn" disabled={lockBusy} onClick={() => void disableLock()}>잠금 해제</button>}
                </div>
              </div>
            </>
          )}
          {lockError && <div className="lock-error">{lockError}</div>}
          <h4>시스템</h4>
          <Toggle k="launchAtLogin" label="로그인 시 자동 실행" desc="트레이에 숨긴 상태로 시작합니다" />
          <Toggle k="closeToTray" label="창을 닫으면 트레이로 최소화" />
          <Toggle k="rememberMe" label="로그인 정보 저장" desc={info && !info.encryption ? "이 시스템에서는 보안 저장소를 사용할 수 없습니다" : "OS 보안 저장소에 암호화"} />
          <Toggle k="autoLogin" label="자동 로그인" disabled={!settings.rememberMe} />
          <Toggle k="flexAutoLogin" label="flex 자동 로그인" desc="저장된 포털 비밀번호로 flex.team에 로그인합니다 (username@ubion.co.kr)" disabled={!settings.rememberMe} />
          <div className="row">
            <div>
              <div>다운로드 폴더</div>
              <div className="muted tiny download-dir">{settings.downloadDir || "기본 다운로드 폴더 (~/Downloads)"}</div>
            </div>
            <div className="row-actions">
              <button className="link small" onClick={async () => { const d = await api().call<string | null>("settings:pickDownloadDir"); if (d) void set({ downloadDir: d }); }}>폴더 선택…</button>
              {settings.downloadDir && <button className="link small" onClick={() => set({ downloadDir: "" })}>기본값</button>}
            </div>
          </div>
          <Toggle k="askSaveLocation" label="매번 저장 위치 묻기" desc="채팅 파일 '저장' 시 저장 위치와 이름을 선택합니다" />
          <h4>업데이트</h4>
          <UpdateRow />
          <Toggle k="autoUpdate" label="자동으로 업데이트 확인" desc="시작할 때와 4시간마다 확인합니다" />
          <p className="muted tiny about">UBION Messenger {info?.version} · {info?.platform}</p>
        </div>
      </div>
    </div>
  );
}

function UpdateRow() {
  const s = useUpdateStatus();
  const label = !s ? "" :
    s.state === "checking" ? "확인 중…" :
    s.state === "none" ? "최신 버전입니다" :
    s.state === "available" ? `새 버전 ${s.version} 있음` :
    s.state === "downloading" ? `${s.version} 다운로드 중 ${s.percent ?? 0}%` :
    s.state === "downloaded" ? `${s.version} 설치 준비됨` :
    s.state === "error" ? `확인 실패: ${s.message}` : "";
  return (
    <div className="row">
      <div>
        <div>현재 버전 {s?.current}</div>
        {label && <div className="muted tiny">{label}</div>}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {s?.state === "available" && <button className="primary small" onClick={() => api().call("update:download")}>다운로드</button>}
        {s?.state === "downloaded" && <button className="primary small" onClick={() => api().call("update:install")}>{api().platform === "darwin" ? "설치 파일 열기" : "설치 후 다시 시작"}</button>}
        <button className="link small" disabled={s?.state === "checking" || s?.state === "downloading"} onClick={() => api().call("update:check")}>업데이트 확인</button>
      </div>
    </div>
  );
}
