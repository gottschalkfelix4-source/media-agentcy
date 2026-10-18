import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: {
      // API_URL=http://localhost:8090 for the demo server (npm run demo)
      '/api': { target: process.env.API_URL ?? 'http://localhost:8080', changeOrigin: false },
    },
  },
});
