import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src",
  base: "",
  publicDir: resolve(import.meta.dirname, "public"),
  build: {
    outDir: resolve(import.meta.dirname, "extension"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        devtools: resolve(import.meta.dirname, "src/devtools.html"),
        panel: resolve(import.meta.dirname, "src/panel.html")
      }
    }
  }
});
