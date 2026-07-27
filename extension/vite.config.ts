import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true, rollupOptions: { input: resolve(import.meta.dirname, "popup.html") } },
  plugins: [{
    name: "extension-static-files",
    closeBundle() {
      copyFileSync("manifest.json", "dist/manifest.json");
      mkdirSync("dist/icons", { recursive: true });
      cpSync("icons", "dist/icons", { recursive: true });
    },
  }],
});
