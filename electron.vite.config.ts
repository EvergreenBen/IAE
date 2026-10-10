import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { quietReload } from './scripts/vite-quiet-reload';

const alias = {
  '@shared': resolve('src/shared'),
  '@renderer': resolve('src/renderer/src'),
};

export default defineConfig({
  main: {
    resolve: { alias },
    build: { externalizeDeps: true },
  },
  preload: {
    resolve: { alias },
    build: {
      externalizeDeps: true,
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias },
    // A reload a builder's edit forces waits until nobody is talking.
    plugins: [react(), quietReload()],
    worker: { format: 'es' },
    // kokoro-js is only imported by a worker, which the dep scan never sees: name it so
    // Vite doesn't discover it mid-session and reload the page.
    optimizeDeps: { exclude: ['@huggingface/transformers'], include: ['kokoro-js'] },
  },
});
