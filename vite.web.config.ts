// Browser-only dev server for the renderer. Runs the UI against the mock bridge
// (src/renderer/src/bridge/mock.ts) so design work and audits need neither
// Electron nor Claude. `npm run web` → http://localhost:5199
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer/src'),
    },
  },
  plugins: [react()],
  worker: { format: 'es' },
  // kokoro-js is only imported by a worker, which the dep scan never sees: name it so
  // Vite doesn't discover it mid-session and reload the page.
  optimizeDeps: { exclude: ['@huggingface/transformers'], include: ['kokoro-js'] },
  server: { port: 5199, strictPort: true },
});
