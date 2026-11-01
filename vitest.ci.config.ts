import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// CI runs a fast, key subset; `pnpm test` (in `pnpm check`) still runs every suite locally.
// Kept here: contracts, the sandbox security boundary, host safety and HTTP guards,
// schema/persistence, the live chat-to-overlay path and the browser response validators.
// Left to local runs: long multi-round integration suites (workflow, transitions,
// proposals, rehearsals, migrations) and the large DOM studio suites.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'packages/sdk/test/**/*.test.ts',
      'packages/compiler/test/**/*.test.ts',
      'packages/twitch/test/**/*.test.ts',
      'packages/sandbox/test/{runtime,engine,verify}.test.ts',
      'apps/server/test/{app,env,database,sessions,twitch-live}.test.ts',
      'apps/web/test/{console,community,proposal-api,rehearsal-api}.test.tsx',
    ],
  },
});
