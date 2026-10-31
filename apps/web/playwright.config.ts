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
      // Run node directly so Playwright's stop signal reaches the server process.
      command: 'rm -f ../../.cache/e2e/riff.db* && exec node --import tsx src/index.ts',
      cwd: '../server',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
      url: 'http://127.0.0.1:8788/api/health',
      env: {
        RIFF_PORT: '8788',
        RIFF_DB_PATH: './.cache/e2e/riff.db',
        RIFF_COMPILER_MODE: 'mock',
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
      },
      reuseExistingServer: false,
    },
    {
      command: 'exec node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
      url: 'http://127.0.0.1:4173',
      env: { RIFF_API_TARGET: 'http://127.0.0.1:8788' },
      reuseExistingServer: false,
    },
  ],
});
