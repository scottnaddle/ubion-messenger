/** true only in the Capacitor build (vite.mobile.config.ts); false in the Electron renderer. */
declare const __UBM_MOBILE__: boolean;

// Node globals referenced by electron/core/daou-client.ts, which the mobile renderer bundles.
// At runtime they come from src/mobile/polyfills.ts (Buffer) and the mobile build's `process.env` define;
// the desktop renderer never loads DaouClient (it runs in main), so do not use these in renderer code.
declare var Buffer: typeof import("buffer").Buffer;
type Buffer = import("buffer").Buffer;
declare var process: { env: Record<string, string | undefined> };
