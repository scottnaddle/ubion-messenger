declare module "ws" {
  import { EventEmitter } from "events";
  import type { IncomingMessage } from "http";
  export default class WebSocket extends EventEmitter {
    constructor(url: string, opts?: { headers?: Record<string, string> });
    static OPEN: number; readyState: number;
    send(d: string): void; close(code?: number, reason?: string): void; terminate(): void;
  }
  export class WebSocketServer extends EventEmitter {
    constructor(o: { noServer?: boolean });
    handleUpgrade(req: IncomingMessage, socket: any, head: Buffer, cb: (ws: WebSocket) => void): void;
    close(): void;
  }
}
