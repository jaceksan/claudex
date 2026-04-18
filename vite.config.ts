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
    // Pre-transform these files eagerly so the browser doesn't wait on a
    // waterfall of on-demand transforms during the first page load.
    warmup: {
      clientFiles: [
        './src/web/main.tsx',
        './src/web/app.tsx',
        './src/web/pages/*.tsx',
        './src/web/components/*.tsx',
      ],
    },
  },
  // Force Vite to prebundle all heavy web deps on startup rather than on
  // the first request that imports them.
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'wouter',
      'react-markdown',
      'remark-gfm',
      'rehype-highlight',
      '@xterm/xterm',
      '@xterm/addon-fit',
      '@git-diff-view/react',
      '@git-diff-view/file',
    ],
  },
  plugins: [tailwindcss(), react()],
});
