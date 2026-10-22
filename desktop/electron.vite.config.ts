import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // Company AI (LiteLLM proxy) — build-time only; empty → feature off. Never commit values.
    define: {
      __UBM_AI_BASE_URL__: JSON.stringify(process.env.UBM_AI_BASE_URL || ""),
      __UBM_AI_KEY__: JSON.stringify(process.env.UBM_AI_KEY || ""),
      __UBM_AI_MODEL__: JSON.stringify(process.env.UBM_AI_MODEL || ""),
    },
    build: { rollupOptions: { input: { index: resolve("electron/main.ts") } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve("electron/preload.ts") } } },
  },
  renderer: {
    root: ".",
    build: { rollupOptions: { input: { index: resolve("index.html") } } },
    plugins: [react()],
  },
});
