import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
/** The Android app's web bundle, which runs its backend in the page (see src/local/). */
const APP_PORT = 4174;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    ...devices['Pixel 7'],
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'web', testIgnore: 'android-app.spec.ts', use: { baseURL: `http://localhost:${PORT}` } },
    { name: 'android-app', testMatch: 'android-app.spec.ts', use: { baseURL: `http://localhost:${APP_PORT}` } },
  ],
  webServer: [
    {
      command: 'npm run build && npx tsx server/index.ts --prod',
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: String(PORT),
        DATABASE_PATH: ':memory:',
        YOUTUBE_API_KEY: '',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        SIMILAR_ARTISTS: 'off',
      },
    },
    {
      command: `npm run build:app && npx vite preview --mode app --port ${APP_PORT} --strictPort`,
      url: `http://localhost:${APP_PORT}/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
