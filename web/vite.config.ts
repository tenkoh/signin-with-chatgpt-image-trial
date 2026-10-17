import { fileURLToPath } from 'node:url';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const apiPort = process.env.SIWC_PORT ?? '1455';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@siwc/public': path.resolve(root, '../server/src/public-types.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
});
