import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const api = process.env.AIE2E_API ?? 'http://127.0.0.1:4173';

// `npm run ui:dev`: hot-reloading UI on :5173, proxying the API/files to `npm start -- ui`.
export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // stable vendor chunks: better caching, no >500 kB warning
        manualChunks: {
          radix: ['radix-ui'],
          lightbox: ['yet-another-react-lightbox'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': api, '/files': api },
  },
});
