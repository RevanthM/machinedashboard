import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_PORT = process.env.API_PORT ?? '8080';
const GUAC_WS_PORT = process.env.GUAC_WS_PORT ?? '8081';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Loopback only, matching the API (PRD §11).
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${API_PORT}`, ws: true },
      // The desktop tunnel lives on its own server; see guac/tunnel.ts for why.
      '/guac': { target: `ws://127.0.0.1:${GUAC_WS_PORT}`, ws: true },
    },
  },
});
