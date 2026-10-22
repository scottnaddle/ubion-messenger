import { useEffect, useState } from "react";
import { api, type SessionUser, type Settings } from "../api";
import { Avatar, Icon } from "./ui";

export function SettingsModal({
  settings, user, onChange, onClose, onLogout,
}: { settings: Settings; user: SessionUser; onChange: (s: Settings) => void; onClose: () => void; onLogout: () => void }) {
  const [info, setInfo] = useState<{ version: string; platform: string; encryption: boolean } | null>(null);
  useEffect(() => {
    api().call("app:info").then(setInfo).catch(() => undefined);
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const set = async (patch: Partial<Settings>) => {
    onChange({ ...settings, ...patch });
    onChange(await api().call<Settings>("settings:set", patch));
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
            <div>글자 크기</div>
            <input type="range" min={12} max={18} value={settings.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} />
          </div>
          <h4>알림</h4>
          <Toggle k="notifications" label="데스크톱 알림" />
          <Toggle k="notificationPreview" label="알림에 메시지 내용 표시" disabled={!settings.notifications} />
          <Toggle k="notificationSound" label="알림 소리" disabled={!settings.notifications} />
          <h4>시스템</h4>
          <Toggle k="launchAtLogin" label="로그인 시 자동 실행" desc="트레이에 숨긴 상태로 시작합니다" />
          <Toggle k="closeToTray" label="창을 닫으면 트레이로 최소화" />
          <Toggle k="rememberMe" label="로그인 정보 저장" desc={info && !info.encryption ? "이 시스템에서는 보안 저장소를 사용할 수 없습니다" : "OS 보안 저장소에 암호화"} />
          <Toggle k="autoLogin" label="자동 로그인" disabled={!settings.rememberMe} />
          <div className="row">
            <div>
              <div>다운로드 폴더</div>
              <div className="muted tiny">{settings.downloadDir || "기본 다운로드 폴더"}</div>
            </div>
            {settings.downloadDir && <button className="link small" onClick={() => set({ downloadDir: "" })}>기본값</button>}
          </div>
          <p className="muted tiny about">UBION Messenger {info?.version} · {info?.platform}</p>
        </div>
      </div>
    </div>
  );
}
