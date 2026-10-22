import { useEffect, useRef } from "react";

export function useEvents(onEvent: (evt: { type: string; payload: any }) => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let closed = false;
    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws/events`);
      ws.onmessage = (e) => {
        try {
          cb.current(JSON.parse(e.data));
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        timer = window.setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
      // keepalive
      const ping = window.setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
      }, 25000);
      ws.addEventListener("close", () => clearInterval(ping));
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);
}
