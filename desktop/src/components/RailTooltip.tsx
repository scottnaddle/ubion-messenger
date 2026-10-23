import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import { nextShowDelay, railTipFor, type RailTipId } from "../rail-tooltip";

type Point = { top: number; left: number };
type SharedState = { activeId: RailTipId | null; at: Point | null };

let lastHiddenAt: number | null = null;
let state: SharedState = { activeId: null, at: null };
let pending: { id: RailTipId; timer: number } | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

function clearPending(id?: RailTipId) {
  if (pending && (id == null || pending.id === id)) {
    window.clearTimeout(pending.timer);
    pending = null;
  }
}

function activate(id: RailTipId, at: Point) {
  state = { activeId: id, at };
  emit();
}

function deactivate(id: RailTipId) {
  clearPending(id);
  if (state.activeId !== id) return;
  lastHiddenAt = Date.now();
  state = { activeId: null, at: null };
  emit();
}

export function resetRailTooltipState() {
  clearPending();
  lastHiddenAt = null;
  state = { activeId: null, at: null };
  emit();
}

function platform(): string {
  return document.documentElement.dataset.platform || navigator.platform;
}

function focusVisible(el: HTMLElement): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

export function useRailTooltip<T extends HTMLElement>(id: RailTipId, name?: string) {
  const ref = useRef<T | null>(null);
  const shared = useSyncExternalStore(subscribe, getSnapshot);
  const open = shared.activeId === id;
  const at = open ? shared.at : null;

  const hide = useCallback(() => {
    deactivate(id);
  }, [id]);

  const show = useCallback(() => {
    clearPending();
    const el = ref.current;
    if (!el) return;
    const delay = nextShowDelay(lastHiddenAt, Date.now(), state.activeId != null);
    const place = () => {
      pending = null;
      const rect = el.getBoundingClientRect();
      activate(id, { top: rect.top + rect.height / 2, left: rect.right + 10 });
    };
    if (delay === 0) place();
    else pending = { id, timer: window.setTimeout(place, delay) };
  }, [id]);

  // Reset the shared state (and the warm window) when a rail item unmounts while open.
  useEffect(() => () => deactivate(id), [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") deactivate(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id]);

  const { label, shortcut } = railTipFor(id, { platform: platform(), name });
  const tipId = `rail-tip-${id}`;
  const keyId = `${tipId}-key`;
  const tooltip =
    open && at
      ? createPortal(
          <div id={tipId} role="tooltip" className="rail-tip" style={{ top: at.top, left: at.left }}>
            <span>{label}</span>
            {shortcut && <span id={keyId} className="rail-tip-key">{" "}{shortcut}</span>}
          </div>,
          document.body,
        )
      : null;

  return {
    ref,
    hide,
    label,
    shortcut,
    tooltip,
    describedBy: open && shortcut ? keyId : undefined,
    handlers: {
      onMouseEnter: show,
      onMouseLeave: hide,
      onFocus: (e: React.FocusEvent<T>) => {
        if (focusVisible(e.currentTarget)) show();
      },
      onBlur: hide,
      onPointerDown: hide,
    },
  };
}

export function RailButton({
  id,
  name,
  active,
  className,
  onClick,
  children,
}: {
  id: RailTipId;
  name?: string;
  active?: boolean;
  className?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const tip = useRailTooltip<HTMLButtonElement>(id, name);
  return (
    <>
      <button
        ref={tip.ref}
        type="button"
        className={`rail-btn${active ? " on" : ""}${className ? ` ${className}` : ""}`}
        aria-label={tip.label}
        aria-describedby={tip.describedBy}
        onClick={() => {
          tip.hide();
          onClick?.();
        }}
        {...tip.handlers}
      >
        {children}
      </button>
      {tip.tooltip}
    </>
  );
}

export function RailProfile({
  name,
  className,
  children,
}: {
  name?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const tip = useRailTooltip<HTMLDivElement>("profile", name);
  return (
    <>
      <div
        ref={tip.ref}
        className={className}
        tabIndex={0}
        role="img"
        aria-label={tip.label}
        aria-describedby={tip.describedBy}
        {...tip.handlers}
      >
        {children}
      </div>
      {tip.tooltip}
    </>
  );
}
