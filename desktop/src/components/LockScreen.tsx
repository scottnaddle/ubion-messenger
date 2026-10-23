import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type UnlockResult } from "../api";
import { Icon } from "./ui";

/** Full-screen lock overlay. The PIN never leaves the renderer except through lock:unlock. */
export function LockScreen({ name, onUnlocked }: { name: string; onUnlocked: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!cooldownUntil) {
      setRemaining(0);
      return;
    }
    const update = () => {
      const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds <= 0) setCooldownUntil(0);
    };
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [cooldownUntil]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || remaining > 0 || !pin) return;
    setBusy(true);
    setError("");
    try {
      const result = await api().call<UnlockResult>("lock:unlock", pin);
      setPin("");
      if (result.ok) {
        onUnlocked();
        return;
      }
      setError(result.error || "PIN이 올바르지 않습니다.");
      if (result.cooldownMs) setCooldownUntil(Date.now() + result.cooldownMs);
      inputRef.current?.focus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lock-screen" role="dialog" aria-modal="true" aria-label="메신저 잠금">
      <form className="lock-card" onSubmit={submit}>
        <div className="lock-icon"><Icon name="lock" size={30} /></div>
        <h2>메신저 잠금</h2>
        <p className="muted small">{name ? `${name}님, PIN을 입력해 주세요.` : "PIN을 입력해 주세요."}</p>
        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          maxLength={12}
          value={pin}
          disabled={busy || remaining > 0}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          placeholder="PIN"
          aria-label="PIN"
        />
        {remaining > 0 ? (
          <div className="lock-cooldown">{remaining}초 후 다시 시도하세요.</div>
        ) : error ? (
          <div className="lock-error">{error}</div>
        ) : null}
        <button className="primary" type="submit" disabled={busy || remaining > 0 || !pin}>
          잠금 해제
        </button>
      </form>
    </div>
  );
}
