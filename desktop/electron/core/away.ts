/**
 * 자리비움(away) detection. `mobileNotice` is a local preference only: turning it off
 * still changes the XMPP presence to away; the server decides whether to push to mobile.
 */

export type AwayConfig = {
  awayMinutes: number;
  mobileNotice: boolean;
};

export type AwayStateInput = {
  idleSec: number;
  awayMinutes: number;
  mobileNotice?: boolean;
  current: boolean;
};

/** Threshold check: 0 (설정 안 함) never goes away; otherwise idle >= minutes * 60. */
export function nextAwayState({ idleSec, awayMinutes }: AwayStateInput): boolean {
  if (!Number.isFinite(awayMinutes) || awayMinutes <= 0) return false;
  return Number.isFinite(idleSec) && idleSec >= awayMinutes * 60;
}

export type AwayMonitorOptions = {
  getIdleSec: () => number;
  setAway: (away: boolean) => void;
  getConfig: () => AwayConfig;
  intervalMs?: number;
  /** Optional extra work on the same tick (used by the auto-lock check in main). */
  onTick?: () => void;
};

export function createAwayMonitor({
  getIdleSec,
  setAway,
  getConfig,
  intervalMs = 15_000,
  onTick,
}: AwayMonitorOptions) {
  let current = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = () => {
    try {
      onTick?.();
      const config = getConfig();
      const next = nextAwayState({
        idleSec: getIdleSec(),
        awayMinutes: config.awayMinutes,
        mobileNotice: config.mobileNotice,
        current,
      });
      if (next !== current) {
        current = next;
        setAway(next);
      }
    } catch {
      // Idle/power APIs can transiently fail (sleep, logout); keep the monitor alive.
    }
  };

  const start = () => {
    if (timer) return;
    timer = setInterval(tick, Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 15_000);
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return {
    start,
    stop,
    tick,
    get current() {
      return current;
    },
  };
}
