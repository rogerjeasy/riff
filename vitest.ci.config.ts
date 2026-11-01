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
      'apps/server/test/{production,production-transports,production-integration,participation,app,env,database,sessions,scenes,recipes,recipe-routes,director,director-policy,collaboration,collaboration-routes,collaboration-transport,collaboration-fencing,collaboration-overlay,twitch-live}.test.ts',
      'apps/web/test/{production,participation,dock-review,console,community,proposal-api,rehearsal-api,scenes,scene-contract,scene-live,recipes,recipe-presentation,collaboration,director}.test.tsx',
    ],
  },
});
