import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Browser calls /api/* ; Vite forwards to the Express server.
      "/api": "http://localhost:3001",
    },
  },
});
