import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Generated source and generated tests are data, never host test modules.
    include: ['apps/server/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/fixtures/**', '**/hostile/**'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    retry: 0,
    env: { RIFF_COMPILER_MODE: 'mock', NODE_ENV: 'test' },
  },
});
