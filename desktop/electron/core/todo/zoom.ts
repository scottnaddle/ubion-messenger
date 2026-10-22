/**
 * Zoom link / meeting ID / passcode parser (KO + EN invites).
 * Never logs passcodes. Pure module.
 */
import type { ZoomParse } from "./types";
import { normalizeKoreanDate } from "./dates-ko";

const ZOOM_HOST = /(?:https?:\/\/)?((?:[a-z0-9-]+\.)*(?:zoom\.us|zoomgov\.com))\//i;
const JOIN_PATH = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:zoom\.us|zoomgov\.com)\/(?:j|w|s)\/(\d{9,11})(?:\?([^\s<>"']*))?/gi;
const VANITY = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:zoom\.us|zoomgov\.com)\/my\/([\w.-]+)/gi;
const DEEP = /zoommtg:\/\/[^\s<>"']+|zoomus:\/\/[^\s<>"']+/gi;

function maskPwdInUrl(url: string): { clean: string; pwd?: string } {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    const pwd = u.searchParams.get("pwd") || undefined;
    u.searchParams.delete("pwd");
    // keep other params
    return { clean: u.toString(), pwd };
  } catch {
    const m = url.match(/[?&]pwd=([^&\s]+)/i);
    const clean = url.replace(/([?&])pwd=[^&\s]+/i, "$1").replace(/[?&]$/, "");
    return { clean, pwd: m?.[1] };
  }
}

function parseDeepLink(link: string): { meetingId?: string; passcode?: string; deepLink: string } {
  const conf = link.match(/[?&]confno=(\d{9,11})/i);
  const pwd = link.match(/[?&]pwd=([^&\s]+)/i);
  return { meetingId: conf?.[1], passcode: pwd?.[1] ? decodeURIComponent(pwd[1]) : undefined, deepLink: link };
}

function extractMeetingIdText(text: string): string | undefined {
  const m =
    text.match(/(?:회의\s*ID|Meeting\s*ID|회의번호|회의\s*번호)\s*[:：]?\s*([\d\s]{9,16})/i) ||
    text.match(/\bID\s*[:：]?\s*([\d\s]{9,16})\b/i);
  if (!m) return undefined;
  const id = m[1].replace(/\s+/g, "");
  return /^\d{9,11}$/.test(id) ? id : undefined;
}

function extractPasscodeText(text: string): string | undefined {
  const m = text.match(/(?:암호|비밀번호|패스워드|Passcode|Password|Pwd)\s*[:：]?\s*([A-Za-z0-9@._*-]+)/i);
  return m?.[1];
}

function extractTitle(text: string): string | undefined {
  const m =
    text.match(/(?:주제|Topic|회의\s*제목)\s*[:：]\s*(.+)/i) ||
    text.match(/Zoom\s*Meeting[:\s]+(.+)/i);
  if (!m) return undefined;
  return m[1].split("\n")[0].trim().slice(0, 120);
}

/**
 * Parse Zoom artifacts from a chat or calendar text blob.
 * Passcode is returned in the result for the caller to store via safeStorage —
 * never write it to logs.
 */
export function parseZoom(text: string, anchorIso?: string): ZoomParse | null {
  if (!text || !/zoom|줌|회의\s*ID|Meeting\s*ID|zoommtg|zoomus/i.test(text)) {
    // still allow bare meeting id patterns with passcode
    if (!/(?:회의\s*ID|Meeting\s*ID)/i.test(text || "")) return null;
  }

  let meetingId: string | undefined;
  let passcode: string | undefined;
  let joinUrl: string | undefined;
  let deepLink: string | undefined;
  let conf = 0;

  for (const m of text.matchAll(JOIN_PATH)) {
    meetingId = m[1];
    const raw = m[0].startsWith("http") ? m[0] : `https://${m[0]}`;
    const { clean, pwd } = maskPwdInUrl(raw);
    joinUrl = clean;
    if (pwd) passcode = pwd;
    conf = Math.max(conf, 0.95);
  }

  if (!meetingId) {
    for (const m of text.matchAll(VANITY)) {
      joinUrl = m[0].startsWith("http") ? m[0] : `https://${m[0]}`;
      conf = Math.max(conf, 0.7);
    }
  }

  for (const m of text.matchAll(DEEP)) {
    const d = parseDeepLink(m[0]);
    deepLink = d.deepLink.replace(/([?&])pwd=[^&\s]+/i, "$1pwd=***"); // masked copy for storage of template? keep real in passcode field
    deepLink = d.deepLink; // store real deep link without logging
    if (d.meetingId) meetingId = d.meetingId;
    if (d.passcode) passcode = d.passcode;
    conf = Math.max(conf, 0.95);
  }

  const idText = extractMeetingIdText(text);
  if (idText) {
    meetingId = meetingId || idText;
    conf = Math.max(conf, 0.9);
  }
  const pwdText = extractPasscodeText(text);
  if (pwdText) passcode = passcode || pwdText;

  if (!meetingId && !joinUrl && !deepLink) return null;

  if (meetingId && !joinUrl) {
    joinUrl = `https://zoom.us/j/${meetingId}`;
  }

  let startIso: string | undefined;
  const dateHit = normalizeKoreanDate(text, anchorIso || new Date());
  // Also try English "Time: Oct 24, 2026 03:00 PM Seoul"
  const en = text.match(
    /Time\s*:\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+20\d{2}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?(?:\s+\w+)?)/i,
  );
  const ko = text.match(/시간\s*:\s*([^\n]+)/);
  if (en) {
    const hit = normalizeKoreanDate(en[1], anchorIso || new Date());
    if (hit) startIso = hit.iso;
  } else if (ko) {
    const hit = normalizeKoreanDate(ko[1], anchorIso || new Date());
    if (hit) startIso = hit.iso;
  } else if (dateHit && (dateHit.precision === "time" || /회의|미팅|줌|zoom/i.test(text))) {
    startIso = dateHit.iso;
  }

  const title = extractTitle(text) || (meetingId ? `Zoom ${meetingId}` : "Zoom 회의");

  return {
    meetingId,
    passcode,
    joinUrl,
    deepLink,
    startIso,
    title,
    confidence: conf || 0.8,
  };
}

/** Build a one-click join target. Prefer zoommtg deep link; fall back to https. */
export function buildZoomJoin(opts: { meetingId?: string; passcode?: string; joinUrl?: string; deepLink?: string }): {
  primary: string;
  fallback?: string;
} {
  const id = opts.meetingId;
  const pwd = opts.passcode;
  if (opts.deepLink && id) {
    // ensure pwd present
    let dl = opts.deepLink;
    if (pwd && !/[?&]pwd=/.test(dl)) dl += (dl.includes("?") ? "&" : "?") + `pwd=${encodeURIComponent(pwd)}`;
    return { primary: dl, fallback: opts.joinUrl || (id ? `https://zoom.us/j/${id}` : undefined) };
  }
  if (id) {
    const q = pwd ? `?pwd=${encodeURIComponent(pwd)}` : "";
    return {
      primary: `zoommtg://zoom.us/join?confno=${id}${pwd ? `&pwd=${encodeURIComponent(pwd)}` : ""}`,
      fallback: opts.joinUrl ? `${opts.joinUrl.replace(/\?.*$/, "")}${q}` : `https://zoom.us/j/${id}${q}`,
    };
  }
  if (opts.joinUrl) {
    let u = opts.joinUrl;
    if (pwd && !/[?&]pwd=/.test(u)) u += (u.includes("?") ? "&" : "?") + `pwd=${encodeURIComponent(pwd)}`;
    return { primary: u };
  }
  return { primary: "https://zoom.us" };
}

/** Mask a passcode for UI / logs. */
export function maskPasscode(pwd: string | undefined | null): string {
  if (!pwd) return "";
  if (pwd.length <= 2) return "••";
  return "•".repeat(Math.min(8, pwd.length));
}
