import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./client", import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./client/src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/client", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
  worker: { format: "es" },
});
