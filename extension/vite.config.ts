import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: { popup: resolve(import.meta.dirname, "popup.html"), background: resolve(import.meta.dirname, "src/background.ts"), content: resolve(import.meta.dirname, "src/content.ts") },
      output: { entryFileNames: (chunk) => chunk.name === "popup" ? "assets/[name]-[hash].js" : "[name].js" },
    },
  },
  plugins: [{
    name: "extension-static-files",
    closeBundle() {
      copyFileSync("manifest.json", "dist/manifest.json");
      mkdirSync("dist/icons", { recursive: true });
      cpSync("icons", "dist/icons", { recursive: true });
    },
  }],
});
