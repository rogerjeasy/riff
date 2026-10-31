import assert from 'node:assert/strict';
import test from 'node:test';
import { findSourceBoundaryErrors } from '../lib/source-boundaries.mjs';

const definitions = [
  { path: 'apps/web', name: '@riff/web', internalDependencies: [] },
  { path: 'apps/server', name: '@riff/server', internalDependencies: ['@riff/sdk'] },
  { path: 'packages/sdk', name: '@riff/sdk', internalDependencies: [] },
  { path: 'packages/compiler', name: '@riff/compiler', internalDependencies: ['@riff/sdk'] },
];
const inspect = (path, source) =>
  findSourceBoundaryErrors({
    root: '/workspace/riff',
    filePath: `/workspace/riff/${path}`,
    source,
    definitions,
  });

test('rejects browser imports of server package subpaths', () => {
  assert.match(
    inspect('apps/web/src/main.ts', "import { secret } from '@riff/server/private';").join('\n'),
    /not allowed/,
  );
});
test('rejects cross-workspace relative imports', () => {
  assert.match(
    inspect('apps/web/src/main.ts', "export { secret } from '../../server/src/secrets.js';").join(
      '\n',
    ),
    /relative import/,
  );
});
test('rejects network clients in the compiler package', () => {
  assert.match(
    inspect('packages/compiler/src/main.ts', "import { request } from 'node:https';").join('\n'),
    /network/,
  );
});
test('rejects forbidden TypeScript import types', () => {
  assert.match(
    inspect(
      'packages/compiler/src/main.ts',
      "type Host = import('@riff/server/private').Host;",
    ).join('\n'),
    /not allowed/,
  );
});
test('rejects network builtin subpaths', () => {
  assert.match(
    inspect('packages/compiler/src/main.ts', "import { lookup } from 'node:dns/promises';").join(
      '\n',
    ),
    /network/,
  );
});
test('rejects network client package subpaths', () => {
  assert.match(
    inspect('packages/compiler/src/main.ts', "import OpenAI from 'openai/client';").join('\n'),
    /network/,
  );
});
test('allows type imports from an approved dependency', () => {
  assert.deepEqual(
    inspect('packages/compiler/src/main.ts', "type Value = import('@riff/sdk').JsonValue;"),
    [],
  );
});
test('rejects dynamically computed package imports', () => {
  assert.match(
    inspect('packages/compiler/src/main.ts', 'const module = await import(name);').join('\n'),
    /static/,
  );
});
test('allows declared SDK imports and ordinary local modules', () => {
  assert.deepEqual(
    inspect(
      'apps/server/src/main.ts',
      "import { SDK_VERSION } from '@riff/sdk'; import './env.js';",
    ),
    [],
  );
});
test('does not mistake comments or text for imports', () => {
  assert.deepEqual(
    inspect(
      'apps/web/src/main.ts',
      '// import x from "@riff/server"\nconst text = "import x from @riff/server";',
    ),
    [],
  );
});
