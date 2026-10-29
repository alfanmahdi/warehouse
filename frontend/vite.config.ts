import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: proxy /api to the backend so the browser stays same-origin (no CORS), like nginx does in Docker.
const proxy = { '/api': process.env.VITE_API_TARGET ?? 'http://localhost:3000' };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: Number(process.env.PREVIEW_PORT ?? 4173), proxy },
});
