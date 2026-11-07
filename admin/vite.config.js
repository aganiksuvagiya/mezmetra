import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In development the API runs on :4000; proxying /api keeps the browser on a single origin (no CORS).
// In production set VITE_API_URL to the API's public origin at build time.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: true, port: 5180, strictPort: true, proxy: { '/api': 'http://localhost:4000' } },
  preview: { host: true, port: 5180 },
});
