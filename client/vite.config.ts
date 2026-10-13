import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SERVER_PORT = process.env.SERVER_PORT ?? "8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    /**
     * In production the server serves this bundle itself, so the client always
     * opens its socket against its own origin. Proxying /ws in dev preserves
     * that single-origin assumption and keeps the client free of any
     * environment-specific URL.
     */
    proxy: {
      "/ws": { target: `ws://localhost:${SERVER_PORT}`, ws: true },
      "/health": { target: `http://localhost:${SERVER_PORT}` },
    },
  },
});
