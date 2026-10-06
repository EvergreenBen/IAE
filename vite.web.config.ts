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
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  server: { port: 5199, strictPort: true },
});
