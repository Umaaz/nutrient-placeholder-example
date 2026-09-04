import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
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
