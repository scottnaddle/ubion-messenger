import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "global.ubion.messenger.dev",
  appName: "UBION Messenger",
  webDir: "dist-mobile",
  plugins: {
    // We call CapacitorHttp explicitly (src/platform/http.ts); do not patch window.fetch/XHR.
    CapacitorHttp: { enabled: false },
    CapacitorCookies: { enabled: true },
  },
  ios: { contentInset: "automatic" },
};

export default config;
