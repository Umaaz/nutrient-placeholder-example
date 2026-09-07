import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages serves a project site from a sub-path (/<repo>/), so every asset URL has to
  // be prefixed with it. The Pages workflow derives it from the repository name, which keeps a
  // fork working without editing this file. Unset — i.e. `pnpm dev` and a local build — means
  // served from the root.
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // The SDK ships a 9MB wasm bundle it loads itself; pre-bundling it in dev only
  // slows the first page load down.
  optimizeDeps: { exclude: ["@nutrient-sdk/document-authoring"] },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
