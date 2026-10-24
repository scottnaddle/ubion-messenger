const reported = new Set<string>();

export function playbackErrorKey(cryptId: string, messageId?: number): string {
  return `${cryptId}:${messageId ?? ""}`;
}

/**
 * First playback failure for an attachment returns true (show the toast).
 * Later calls — Chromium retries, remounts, the viewer opening the same file — return false.
 */
export function claimPlaybackError(key: string): boolean {
  if (!key || reported.has(key)) return false;
  reported.add(key);
  return true;
}

export function resetPlaybackErrors(): void {
  reported.clear();
}
