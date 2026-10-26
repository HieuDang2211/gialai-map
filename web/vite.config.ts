import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Khi dev: chạy `docker compose up` trước, Vite chuyển /api và /tiles sang gateway (cổng 8088)
const gateway = process.env.GATEWAY_URL ?? 'http://localhost:8088';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': gateway, '/tiles': gateway },
  },
  build: {
    target: 'es2020',
    // maplibre ~800 KB (218 KB gzip) là chủ đích, nằm trong chunk riêng
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Tách maplibre ra chunk riêng: ít thay đổi -> cache trình duyệt lâu dài
        manualChunks: { maplibre: ['maplibre-gl'], react: ['react', 'react-dom'] },
      },
    },
  },
});
