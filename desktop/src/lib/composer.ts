/** Korean/CJK IME: ignore Enter while a composition session is active. */
export function shouldIgnoreEnterForSend(opts: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  composingRef?: boolean;
}): boolean {
  if (opts.key !== "Enter" || opts.shiftKey) return true;
  if (opts.isComposing) return true;
  if (opts.keyCode === 229) return true;
  if (opts.composingRef) return true;
  return false;
}

export function isSendEnter(opts: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  composingRef?: boolean;
}): boolean {
  if (opts.key !== "Enter" || opts.shiftKey) return false;
  return !shouldIgnoreEnterForSend(opts);
}
