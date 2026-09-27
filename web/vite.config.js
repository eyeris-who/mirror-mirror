import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Browser calls /api/* ; Vite forwards to the Express server.
      // 127.0.0.1, not localhost: the server binds loopback addresses and
      // Windows resolves localhost to ::1 first.
      "/api": "http://127.0.0.1:3001",
    },
  },
});
