import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { getPorts } from "../../packages/config/src/ports.js";

const ports = getPorts();

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: ports.web,
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${ports.api}` },
  },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
