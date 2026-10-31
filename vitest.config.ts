import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Generated source and generated tests are data, never host test modules.
    include: [
      'apps/server/test/**/*.test.ts',
      'apps/web/test/**/*.test.tsx',
      'packages/*/test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/fixtures/**', '**/hostile/**'],
    environment: 'node',
    // Cold WASM workers have a separate bounded startup budget.
    testTimeout: 20_000,
    clearMocks: true,
    restoreMocks: true,
    retry: 0,
    env: { RIFF_COMPILER_MODE: 'mock', NODE_ENV: 'test' },
  },
});
