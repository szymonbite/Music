import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The Android app (`vite build --mode app`) runs the server's code inside the
// app, so the few Node-only modules it imports are swapped for small stand-ins.
const appAliases = [
  { find: /^express$/, replacement: fileURLToPath(new URL('./src/local/express.ts', import.meta.url)) },
  { find: /^node:crypto$/, replacement: fileURLToPath(new URL('./src/local/node-crypto.ts', import.meta.url)) },
];

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: mode === 'app' ? { alias: appAliases } : undefined,
  build: {
    outDir: mode === 'app' ? 'dist-app' : 'dist',
    sourcemap: mode !== 'app',
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          include: ['server/**/*.test.ts', 'shared/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'client',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['src/local/**'],
          environment: 'jsdom',
          setupFiles: ['src/test/setup.ts'],
        },
      },
      {
        extends: true,
        resolve: { alias: appAliases },
        test: {
          name: 'app',
          include: ['src/local/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
}));
