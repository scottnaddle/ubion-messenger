import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

function ubmFlavor(): "ubion" | "generic" {
  const v = (process.env.UBM_FLAVOR || "").trim().toLowerCase();
  return v === "generic" || v === "dawer" ? "generic" : "ubion";
}

const flavor = ubmFlavor();
const define = { __UBM_FLAVOR__: JSON.stringify(flavor) };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define,
    build: { rollupOptions: { input: { index: resolve("electron/main.ts") } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define,
    build: { rollupOptions: { input: { index: resolve("electron/preload.ts"), capture: resolve("electron/capture-preload.ts") } } },
  },
  renderer: {
    define,
    root: ".",
    build: { rollupOptions: { input: { index: resolve("index.html") } } },
    plugins: [
      react(),
      {
        name: "ubm-flavor-title",
        transformIndexHtml(html: string) {
          const title = flavor === "generic" ? "다워" : "UBION Messenger";
          return html.replace("<title>UBION Messenger</title>", `<title>${title}</title>`);
        },
      },
    ],
  },
});
