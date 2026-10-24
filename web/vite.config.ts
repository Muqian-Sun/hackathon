import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const bridgePort = process.env.PORT ?? '8787';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${bridgePort}`, ws: true },
    },
  },
});
