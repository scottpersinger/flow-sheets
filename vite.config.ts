/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3001' },
  },
  build: { outDir: '../dist/client', emptyOutDir: true },
  test: { root: '.', include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'client/src/**/*.test.ts'] },
});
