import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/web'),
  build: { outDir: path.resolve(__dirname, 'dist/web'), emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:7878',
      '/ws': { target: 'ws://localhost:7878', ws: true },
    },
  },
  plugins: [tailwindcss(), react()],
});
