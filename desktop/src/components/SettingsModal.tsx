import { useEffect, useState } from "react";
import { api, type LockStatus, type SessionUser, type Settings } from "../api";
import { Avatar, Icon } from "./ui";
import { useUpdateStatus } from "./UpdateBanner";
import { THEME_MAX_BYTES, THEME_PRESETS, type ThemePresetId, type ThemeState } from "../../electron/core/theme";
import { LANGUAGES, LANGUAGE_NAMES, tk, useT, type Language } from "../lib/i18n";

const PRESET_LABELS: Record<ThemePresetId, string> = { default: tk("기본"), blue: tk("블루"), green: tk("그린"), purple: tk("퍼플") };

export function SettingsModal({
  settings, user, onChange, onClose, onLogout,
}: { settings: Settings; user: SessionUser; onChange: (s: Settings) => void; onClose: () => void; onLogout: () => void }) {
  const t = useT();
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
    return r.removed.length ? t("가져왔습니다. 안전하지 않은 항목을 제거했습니다: {items}", { items: r.removed.join(", ") }) : t("가져와서 적용했습니다.");
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
      setLockError(t("PIN이 일치하지 않습니다."));
      return;
    }
    if (!/^\d{4,12}$/.test(lockNewPin)) {
      setLockError(t("PIN은 4~12자리 숫자입니다."));
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
      setLockError(t("현재 PIN을 입력하세요."));
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
          <h2>{t("설정")}</h2>
          <button className="icon-btn" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="modal-body">
          <section className="me-card">
            <Avatar name={user.name} src={user.thumbnail} size={48} />
            <div className="grow">
              <div className="name">{user.name}</div>
              <div className="muted small">{user.loginId} · {settings.serverUrl.replace(/^https?:\/\//, "")}</div>
            </div>
            <button className="danger-btn" onClick={onLogout}>{t("로그아웃")}</button>
          </section>
          <h4>{t("화면")}</h4>
          <div className="row">
            <div>{t("언어")}</div>
            <select value={settings.language || "ko"} onChange={(e) => set({ language: e.target.value as Language })}>
              {LANGUAGES.map((l) => <option key={l} value={l}>{LANGUAGE_NAMES[l]}</option>)}
            </select>
          </div>
          <div className="row">
            <div>{t("테마")}</div>
            <div className="seg">
              {(["system", "light", "dark"] as const).map((th) => (
                <button key={th} className={settings.theme === th ? "on" : ""} onClick={() => set({ theme: th })}>
                  {{ system: t("시스템"), light: t("라이트"), dark: t("다크") }[th]}
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <div>{t("색상")}</div>
            <div className="theme-presets">
              {THEME_PRESETS.map((p) => (
                <button key={p.id} className={(settings.themePreset || "default") === p.id ? "on" : ""} title={t(PRESET_LABELS[p.id] || p.name)} onClick={() => set({ themePreset: p.id })}>
                  <span className="swatch" style={{ background: p.swatch }} />{t(PRESET_LABELS[p.id] || p.name)}
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <div>
              <div>{t("사용자 테마")}</div>
              <div className="muted tiny">{t("CSS 파일({kb}KB 이하)을 가져와 화면에 덧씌웁니다. 외부 URL·@import·스크립트는 제거됩니다.", { kb: THEME_MAX_BYTES / 1024 })}</div>
            </div>
            <button className="link small" disabled={themeBusy} onClick={() => void importTheme()}>{t("CSS 가져오기…")}</button>
          </div>
          {(settings.customThemes || []).length > 0 && (
            <div className="theme-list">
              <div className="row">
                <label className="theme-name">
                  <input type="radio" name="custom-theme" checked={!settings.activeThemeId} disabled={themeBusy}
                    onChange={() => void themeOp(async () => applyThemeState(await api().theme.activate(null)))} />
                  <span>{t("사용 안 함")}</span>
                </label>
              </div>
              {settings.customThemes!.map((ct) => (
                <div className="row" key={ct.id}>
                  <label className="theme-name">
                    <input type="radio" name="custom-theme" checked={settings.activeThemeId === ct.id} disabled={themeBusy}
                      onChange={() => void themeOp(async () => applyThemeState(await api().theme.activate(ct.id)))} />
                    <span>{ct.name}</span>
                  </label>
                  <button className="link small danger" disabled={themeBusy}
                    onClick={() => void themeOp(async () => applyThemeState(await api().theme.remove(ct.id)))}>{t("삭제")}</button>
                </div>
              ))}
            </div>
          )}
          {themeMsg && <div className={themeMsg.error ? "lock-error" : "muted tiny"}>{themeMsg.text}</div>}
          <div className="row">
            <div>{t("글자 크기")}</div>
            <input type="range" min={12} max={18} value={settings.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} />
          </div>
          <h4>{t("알림")}</h4>
          <Toggle k="notifications" label={t("데스크톱 알림")} />
          <Toggle k="notificationPreview" label={t("알림에 메시지 내용 표시")} disabled={!settings.notifications} />
          <Toggle k="notificationSound" label={t("알림 소리")} disabled={!settings.notifications} />
          <Toggle k="portalPostNotify" label={t("전사게시판 새 글 알림")} desc={t("홈 탭: 새 전사 공지를 데스크톱 알림으로 표시")} disabled={!settings.notifications} />
          <div className="row">
            <div>
              <div>{t("포털(홈) 링크 열기")}</div>
              <div className="muted small">{t("앱 안 창: 메신저 로그인 그대로 사용(재로그인 불필요) · 외부 브라우저: 웹 로그인이 필요할 수 있음")}</div>
            </div>
            <select value={settings.portalOpenMode} onChange={(e) => set({ portalOpenMode: e.target.value as "inapp" | "external", portalOpenModeChosen: true })}>
              <option value="inapp">{t("앱 안 창 (자동 로그인)")}</option>
              <option value="external">{t("외부 브라우저")}</option>
            </select>
          </div>
          <h4>{t("부재 설정")}</h4>
          <div className="row">
            <div>
              <div>{t("PC 메신저 부재 설정")}</div>
              <div className="muted tiny">{t("※ 설정한 시간 동안 PC를 사용하지 않으면 모바일 앱으로 알림을 전송하며 자리비움 상태로 전환합니다.")}</div>
            </div>
            <select value={settings.awayMinutes} onChange={(e) => set({ awayMinutes: Number(e.target.value) as Settings["awayMinutes"] })}>
              <option value={1}>{t("{n}분 후", { n: 1 })}</option>
              <option value={5}>{t("{n}분 후", { n: 5 })}</option>
              <option value={10}>{t("{n}분 후", { n: 10 })}</option>
              <option value={15}>{t("{n}분 후", { n: 15 })}</option>
              <option value={0}>{t("설정 안 함")}</option>
            </select>
          </div>
          <Toggle k="mobileNotice" label={t("PC 미사용 시 모바일로 알림")} desc={t("자리비움 상태가 되면 모바일 앱으로 알림을 전송합니다 (모바일 푸시 동작은 서버 정책에 따름)")} />
          <h4>{t("메신저 잠금")}</h4>
          <div className="row">
            <div>
              <div>{t("자동 잠금")}</div>
              <div className="muted tiny">{t("설정한 시간 동안 PC를 사용하지 않으면 메신저를 잠급니다.")}</div>
            </div>
            <select value={settings.lockTimeoutMin} onChange={(e) => set({ lockTimeoutMin: Number(e.target.value) as Settings["lockTimeoutMin"] })}>
              <option value={0}>{t("사용 안 함")}</option>
              <option value={1}>{t("{n}분 후", { n: 1 })}</option>
              <option value={5}>{t("{n}분 후", { n: 5 })}</option>
              <option value={10}>{t("{n}분 후", { n: 10 })}</option>
              <option value={30}>{t("{n}분 후", { n: 30 })}</option>
              <option value={60}>{t("{n}분 후", { n: 60 })}</option>
            </select>
          </div>
          {lockUnsupported ? (
            <div className="muted tiny">{t("OS 보안 저장소를 사용할 수 없어 잠금을 설정할 수 없습니다.")}</div>
          ) : (
            <>
              {lock?.enabled && (
                <div className="row">
                  <div>{t("현재 PIN")}</div>
                  <input type="password" inputMode="numeric" autoComplete="off" value={lockCurrentPin} onChange={(e) => setLockCurrentPin(e.target.value)} />
                </div>
              )}
              <div className="row">
                <div>{lock?.enabled ? t("새 PIN") : "PIN"}</div>
                <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={lockNewPin} onChange={(e) => setLockNewPin(e.target.value.replace(/\D/g, ""))} />
              </div>
              <div className="row">
                <div>{lock?.enabled ? t("새 PIN 확인") : t("PIN 확인")}</div>
                <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={lockConfirmPin} onChange={(e) => setLockConfirmPin(e.target.value.replace(/\D/g, ""))} />
              </div>
              <div className="row">
                <div className="muted tiny">{lock?.enabled ? t("PIN을 변경하거나 잠금을 해제할 수 있습니다.") : t("PIN을 설정하면 앱 시작 시 잠금 화면이 표시됩니다.")}</div>
                <div className="row-actions">
                  <button className="primary small" disabled={lockBusy} onClick={() => void saveLockPin()}>{lock?.enabled ? t("PIN 변경") : t("잠금 설정")}</button>
                  {lock?.enabled && <button className="danger-btn" disabled={lockBusy} onClick={() => void disableLock()}>{t("잠금 해제")}</button>}
                </div>
              </div>
            </>
          )}
          {lockError && <div className="lock-error">{lockError}</div>}
          <h4>{t("시스템")}</h4>
          <Toggle k="launchAtLogin" label={t("로그인 시 자동 실행")} desc={t("트레이에 숨긴 상태로 시작합니다")} />
          <Toggle k="closeToTray" label={t("창을 닫으면 트레이로 최소화")} />
          <Toggle k="rememberMe" label={t("로그인 정보 저장")} desc={info && !info.encryption ? t("이 시스템에서는 보안 저장소를 사용할 수 없습니다") : t("OS 보안 저장소에 암호화")} />
          <Toggle k="autoLogin" label={t("자동 로그인")} disabled={!settings.rememberMe} />
          <Toggle k="flexAutoLogin" label={t("flex 자동 로그인")} desc={t("저장된 포털 비밀번호로 flex.team에 로그인합니다 (username@ubion.co.kr)")} disabled={!settings.rememberMe} />
          <div className="row">
            <div>
              <div>{t("다운로드 폴더")}</div>
              <div className="muted tiny download-dir">{settings.downloadDir || t("기본 다운로드 폴더 (~/Downloads)")}</div>
            </div>
            <div className="row-actions">
              <button className="link small" onClick={async () => { const d = await api().call<string | null>("settings:pickDownloadDir"); if (d) void set({ downloadDir: d }); }}>{t("폴더 선택…")}</button>
              {settings.downloadDir && <button className="link small" onClick={() => set({ downloadDir: "" })}>{t("기본값")}</button>}
            </div>
          </div>
          <Toggle k="askSaveLocation" label={t("매번 저장 위치 묻기")} desc={t("채팅 파일 '저장' 시 저장 위치와 이름을 선택합니다")} />
          <h4>{t("업데이트")}</h4>
          <UpdateRow />
          <Toggle k="autoUpdate" label={t("자동으로 업데이트 확인")} desc={t("시작할 때와 4시간마다 확인합니다")} />
          <p className="muted tiny about">UBION Messenger {info?.version} · {info?.platform}</p>
        </div>
      </div>
    </div>
  );
}

function UpdateRow() {
  const t = useT();
  const s = useUpdateStatus();
  const label = !s ? "" :
    s.state === "checking" ? t("확인 중…") :
    s.state === "none" ? t("최신 버전입니다") :
    s.state === "available" ? t("새 버전 {version} 있음", { version: s.version }) :
    s.state === "downloading" ? t("{version} 다운로드 중 {percent}%", { version: s.version, percent: s.percent ?? 0 }) :
    s.state === "downloaded" ? t("{version} 설치 준비됨", { version: s.version }) :
    s.state === "error" ? t("확인 실패: {message}", { message: s.message }) : "";
  return (
    <div className="row">
      <div>
        <div>{t("현재 버전 {version}", { version: s?.current })}</div>
        {label && <div className="muted tiny">{label}</div>}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {s?.state === "available" && <button className="primary small" onClick={() => api().call("update:download")}>{t("다운로드")}</button>}
        {s?.state === "downloaded" && <button className="primary small" onClick={() => api().call("update:install")}>{api().platform === "darwin" ? t("설치 파일 열기") : t("설치 후 다시 시작")}</button>}
        <button className="link small" disabled={s?.state === "checking" || s?.state === "downloading"} onClick={() => api().call("update:check")}>{t("업데이트 확인")}</button>
      </div>
    </div>
  );
}
