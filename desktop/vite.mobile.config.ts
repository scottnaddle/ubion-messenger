import { resolve } from "path";
import { readFileSync } from "fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as { version: string };

/** Capacitor (iOS/iPad/Android) web build of the renderer: `npm run build:mobile` → dist-mobile/. */
export default defineConfig({
  root: ".",
  base: "./",
  plugins: [react()],
  define: {
    __UBM_MOBILE__: "true",
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version),
    // DaouClient feature gates read process.env (all off on mobile).
    "process.env": "{}",
  },
  resolve: {
    alias: [
      // npm `buffer` package instead of Vite's empty browser stub for the Node builtin.
      { find: /^buffer$/, replacement: resolve(__dirname, "node_modules/buffer/index.js") },
      { find: /^(node:)?events$/, replacement: resolve(__dirname, "src/mobile/shims/events.ts") },
      // ubm-auth PKCE (randomBytes + sha256) for Capacitor — never Node's crypto.
      { find: /^(node:)?crypto$/, replacement: resolve(__dirname, "src/mobile/shims/crypto.ts") },
    ],
  },
  build: {
    outDir: "dist-mobile",
    emptyOutDir: true,
    target: "es2020",
    rollupOptions: { input: { index: resolve(__dirname, "index.html") } },
  },
});
