import { useCallback, useEffect, useRef, useState } from "react";
import type { Settings } from "../api";
import { applySavedLanguage, useT, type I18nCaps } from "../lib/i18n";
import {
  CONNECTORS,
  loadConnectorPrefs,
  resolveConnectors,
  saveConnectorPrefs,
  type ConnectorLinkMap,
  type ConnectorPrefs,
  type ConnectorState,
} from "../lib/connectors";
import {
  readSettingsSnapshot,
  selectBotSettingsSection,
  settingsNav,
  type BotSettingsLink,
  type BotSettingsSectionId,
  type BotSettingsSnapshot,
} from "../lib/personal-bot-settings";
import type { PersonalBotStorage } from "../lib/personal-bot";

type GoogleConnectorId = "google-drive" | "google-calendar";

function googleBridge() {
  return typeof window === "undefined" ? undefined : window.ubion?.google;
}

function connectorLabel(t: (key: string) => string, id: string): string {
  if (id === "ubion-mail") return t("회사 메일");
  if (id === "ubion-approval") return t("결재 대기");
  if (id === "ubion-calendar") return t("오늘 일정");
  if (id === "google-drive") return t("Google Drive");
  if (id === "google-calendar") return t("Google Calendar");
  return id;
}

function sectionLabel(t: (key: string) => string, id: string): string {
  if (id === "connectors") return t("커넥터");
  return id;
}

function connectorStateLabel(t: (key: string) => string, state: ConnectorState): string {
  if (state === "ready") return t("사용 중");
  if (state === "off") return t("꺼짐");
  return t("나중에 연결");
}

function linkFlags(links: Record<string, BotSettingsLink>): ConnectorLinkMap {
  const flags: Record<string, boolean> = {};
  for (const [id, link] of Object.entries(links)) {
    if (link.connected) flags[id] = true;
  }
  return flags;
}

function linksFromStatus(status: { connectors: { id: string; connected: boolean; account?: string }[] }): Record<string, BotSettingsLink> {
  return readSettingsSnapshot({
    prefs: {},
    links: Object.fromEntries(status.connectors.map((item) => [item.id, { connected: item.connected, account: item.account }])),
  })?.links ?? {};
}

/**
 * Dedicated 내 봇 settings surface: section nav on the left, the selected page
 * on the right. The Electron app hosts this in a child window. Without that
 * bridge it fills the chat column instead of a dropdown.
 */
export function PersonalBotSettings({
  userId,
  storage,
  onClose,
  onChanged,
}: {
  userId: number;
  storage?: PersonalBotStorage;
  onClose?: () => void;
  onChanged?: (snapshot: BotSettingsSnapshot) => void;
}) {
  const t = useT();
  const store = storage ?? localStorage;
  const [section, setSection] = useState<BotSettingsSectionId>(() => selectBotSettingsSection(null));
  const [prefs, setPrefs] = useState<ConnectorPrefs>(() => loadConnectorPrefs(store, userId));
  const [links, setLinks] = useState<Record<string, BotSettingsLink>>({});
  const [busyId, setBusyId] = useState("");
  const [connectError, setConnectError] = useState("");
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    let cancel = false;
    const loaded = loadConnectorPrefs(store, userId);
    setPrefs(loaded);
    setLinks({});
    setBusyId("");
    setConnectError("");
    setSection(selectBotSettingsSection(null));
    const google = googleBridge();
    if (!google) return;
    void google.status(userId).then((status) => {
      if (cancel) return;
      const nextLinks = linksFromStatus(status);
      setLinks(nextLinks);
      onChangedRef.current?.({ prefs: loadConnectorPrefs(store, userId), links: nextLinks });
    }).catch(() => { /* stay connect-later until the next attempt */ });
    return () => { cancel = true; };
  }, [store, userId]);

  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const publish = (nextPrefs: ConnectorPrefs, nextLinks: Record<string, BotSettingsLink>) => {
    onChanged?.({ prefs: nextPrefs, links: nextLinks });
  };

  const toggle = (id: string, state: ConnectorState) => {
    const enabled = state === "off";
    const next = { ...prefs, [id]: { ...prefs[id], enabled } };
    setPrefs(next);
    saveConnectorPrefs(store, userId, next);
    publish(next, links);
  };

  const connectGoogle = (id: GoogleConnectorId) => {
    const google = googleBridge();
    if (!google) {
      setConnectError(t("Google 연결은 앱에서만 사용할 수 있습니다."));
      return;
    }
    if (busyId) return;
    setBusyId(id);
    setConnectError("");
    void google.connect(userId, id).then(() => google.status(userId)).then((status) => {
      const nextLinks = linksFromStatus(status);
      setLinks(nextLinks);
      publish(prefsRef.current, nextLinks);
    }).catch((e: unknown) => {
      const message = e instanceof Error && e.message ? e.message : t("Google 연결에 실패했습니다.");
      setConnectError(message);
    }).finally(() => setBusyId((current) => (current === id ? "" : current)));
  };

  const disconnectGoogle = (id: GoogleConnectorId) => {
    const google = googleBridge();
    if (!google || busyId) return;
    setBusyId(id);
    setConnectError("");
    void google.disconnect(userId, id).then(() => google.status(userId)).then((status) => {
      const nextLinks = linksFromStatus(status);
      setLinks(nextLinks);
      publish(prefsRef.current, nextLinks);
    }).catch((e: unknown) => {
      const message = e instanceof Error && e.message ? e.message : t("Google 연결에 실패했습니다.");
      setConnectError(message);
    }).finally(() => setBusyId((current) => (current === id ? "" : current)));
  };

  const nav = settingsNav(section);
  const resolved = resolveConnectors(prefs, CONNECTORS, linkFlags(links));

  return (
    <div className="bot-settings" role="dialog" aria-label={t("내 봇 설정")}>
      <header className="bot-settings-head">
        <div>
          <div className="bot-settings-title">{t("내 봇 설정")}</div>
          <div className="sub muted">{t("유비온 비서")}</div>
        </div>
        {onClose && (
          <button type="button" className="bot-conn-btn" onClick={onClose}>{t("닫기")}</button>
        )}
      </header>
      <div className="bot-settings-body">
        <nav className="bot-settings-nav" aria-label={t("내 봇 설정")}>
          {nav.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.active ? "on" : ""}
              aria-current={item.active ? "page" : undefined}
              onClick={() => setSection(selectBotSettingsSection(item.id))}
            >
              {sectionLabel(t, item.id)}
            </button>
          ))}
        </nav>
        <div className="bot-settings-main">
          {section === "connectors" && (
            <>
              <h2>{t("커넥터")}</h2>
              <p className="muted bot-settings-lead">{t("켜 둔 것만 비서가 씁니다. Google은 여기서 연결해요.")}</p>
              {connectError && <div className="banner bad" role="alert">{connectError}</div>}
              <div className="bot-conn-list">
                {resolved.map((connector) => {
                  const linked = links[connector.id];
                  const googleId = connector.id === "google-drive" || connector.id === "google-calendar" ? connector.id : null;
                  const stateText = googleId && connector.state === "ready" ? t("연결됨") : connectorStateLabel(t, connector.state);
                  const account = googleId && linked?.account ? ` · ${linked.account}` : "";
                  return (
                    <div key={connector.id} className="bot-conn">
                      <div className="bot-conn-copy">
                        <div className="bot-conn-name">{connectorLabel(t, connector.id)}</div>
                        <div className="muted tiny">{stateText}{account}</div>
                      </div>
                      <div className="bot-conn-actions">
                        {googleId && connector.state === "connect-later" && (
                          <button type="button" className="bot-conn-btn" disabled={!!busyId} onClick={() => connectGoogle(googleId)}>
                            {busyId === googleId ? t("연결 중") : t("연결")}
                          </button>
                        )}
                        {googleId && linked?.connected && (
                          <button type="button" className="bot-conn-btn" disabled={!!busyId} onClick={() => disconnectGoogle(googleId)}>
                            {t("연결 해제")}
                          </button>
                        )}
                        <input
                          type="checkbox"
                          className="switch"
                          aria-label={connectorLabel(t, connector.id)}
                          checked={connector.state !== "off"}
                          onChange={() => toggle(connector.id, connector.state)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Child BrowserWindow entry. Same component as the in-app fallback. */
export function PersonalBotSettingsWindow({ userId }: { userId: number }) {
  const t = useT();
  const close = useCallback(() => window.close(), []);
  const changed = useCallback((snapshot: BotSettingsSnapshot) => {
    void window.ubion?.personalBotSettings?.changed?.(userId, snapshot);
  }, [userId]);
  useEffect(() => {
    document.title = t("내 봇 설정");
  }, [t]);
  useEffect(() => {
    const bridge = window.ubion;
    if (!bridge?.call) return;
    let cancel = false;
    void (async () => {
      const settings = await bridge.call<Settings>("settings:get").catch(() => null);
      const caps = await bridge.call<I18nCaps>("i18n:caps").catch(() => null);
      if (cancel || !settings) return;
      applySavedLanguage(settings.language, !!caps?.enabled);
      const dark = settings.theme === "dark" || (settings.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      document.documentElement.style.setProperty("--fs", `${settings.fontSize || 14}px`);
      if (!settings.themePreset || settings.themePreset === "default") delete document.documentElement.dataset.preset;
      else document.documentElement.dataset.preset = settings.themePreset;
    })();
    return () => { cancel = true; };
  }, []);
  return <PersonalBotSettings userId={userId} onClose={close} onChanged={changed} />;
}
