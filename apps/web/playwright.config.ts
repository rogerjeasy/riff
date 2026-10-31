import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @riff/server exec node --import tsx src/index.ts',
      cwd: '../..',
      url: 'http://127.0.0.1:8788/api/health',
      env: {
        RIFF_PORT: '8788',
        RIFF_DB_PATH: './.cache/e2e/riff.db',
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
      },
      reuseExistingServer: false,
    },
    {
      command: 'pnpm run dev --port 4173',
      url: 'http://127.0.0.1:4173',
      env: { RIFF_API_TARGET: 'http://127.0.0.1:8788' },
      reuseExistingServer: false,
    },
  ],
});
