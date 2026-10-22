import type React from "react";
import { useState } from "react";
import type { Presence } from "../api";
import { media } from "../api";
import { hue, initials } from "../lib/format";

export function Avatar({ name, src, size = 36, presence }: { name: string; src?: string; size?: number; presence?: Presence }) {
  const [broken, setBroken] = useState(false);
  const url = src && !broken ? media(src) : "";
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4, background: url ? undefined : `hsl(${hue(name)} 55% 52%)` }}>
      {url ? <img src={url} alt="" onError={() => setBroken(true)} draggable={false} /> : initials(name)}
      {presence && <i className={`pres ${presence}`} />}
    </span>
  );
}

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const p: Record<string, React.ReactElement> = {
    home: <path d="M3.5 11 12 4l8.5 7M6 9.5V20h4.5v-5h3v5H18V9.5" />,
    chat: <path d="M4 5h16v11H8l-4 4z" />,
    people: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.6 3.3-5.5 6.5-5.5s5.7 1.9 6.5 5.5" /><circle cx="17" cy="9" r="2.5" /><path d="M17 14c2.4 0 4 1.5 4.6 4" /></>,
    gear: <><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></>,
    clip: <path d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7" />,
    send: <path d="M3 11.5 21 3l-8.5 18-2-7.5z" />,
    search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
    close: <path d="M6 6l12 12M18 6 6 18" />,
    download: <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" />,
    pin: <path d="M9 4h6l-1 6 4 3v2h-5v5l-1 1-1-1v-5H6v-2l4-3z" />,
    file: <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /></>,
    image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="m4 18 5.5-5 4 3.5 3-2.5 4 4" /></>,
    refresh: <path d="M19 12a7 7 0 1 1-2-4.9M19 4v4.5h-4.5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5h4" />,
    grid: <><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 6.5 8.5 6 8.5-6" /></>,
    calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M8 3v4M16 3v4M3.5 10h17" /></>,
    briefcase: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2M3 12.5h18" /></>,
    board: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 3h6v3H9zM8.5 11h7M8.5 15h5" /></>,
    approval: <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /><path d="m9.5 14.5 2 2 4-4" /></>,
    report: <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h6" /></>,
    clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
    survey: <><path d="M10 6h10M10 12h10M10 18h10" /><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5 2.5-2.5M3.5 18l1.5 1.5 2.5-2.5" /></>,
    community: <><circle cx="12" cy="8" r="3" /><circle cx="5.5" cy="10" r="2.2" /><circle cx="18.5" cy="10" r="2.2" /><path d="M7 19c.6-3 2.6-4.5 5-4.5s4.4 1.5 5 4.5M2.5 18c.3-2 1.4-3.2 3-3.5M21.5 18c-.3-2-1.4-3.2-3-3.5" /></>,
    contact: <><rect x="5" y="3" width="15" height="18" rx="2" /><circle cx="12.5" cy="10" r="2.5" /><path d="M8.5 17c.6-2 2-3 4-3s3.4 1 4 3M3 7h3M3 12h3M3 17h3" /></>,
    cloud: <path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.6 4.5 4.5 0 0 0 7 18.5z" />,
    todo: <><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="m8.5 12 2.5 2.5 5-5" /></>,
    door: <><path d="M5 21V4.5A1.5 1.5 0 0 1 6.5 3h11A1.5 1.5 0 0 1 19 4.5V21M3 21h18" /><circle cx="15" cy="12.5" r=".9" /></>,
    car: <><path d="M5 16.5V12l2-5.5h10l2 5.5v4.5M5 12h14" /><circle cx="8" cy="16.5" r="1.8" /><circle cx="16" cy="16.5" r="1.8" /></>,
    link: <><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></>,
    external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></>,
    bellOff: <><path d="M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l1.5 2H8" /><path d="m4 4 16 16" /></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {p[name]}
    </svg>
  );
}
