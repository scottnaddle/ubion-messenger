/** Node globals DaouClient relies on, for the browser/WKWebView bundle (aliased to the `buffer` npm package). */
import { Buffer } from "buffer";

const g = globalThis as { Buffer?: unknown };
if (!g.Buffer) g.Buffer = Buffer;
