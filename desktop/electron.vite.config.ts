import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve("electron/main.ts") } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve("electron/preload.ts"), capture: resolve("electron/capture-preload.ts") } } },
  },
  renderer: {
    root: ".",
    build: { rollupOptions: { input: { index: resolve("index.html") } } },
    plugins: [react()],
    define: { __UBM_MOBILE__: "false" },
  },
});
