import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWorkspaceGraph } from '../lib/workspaces.mjs';

const definitions = [
  { name: '@riff/sdk', path: 'packages/sdk', internalDependencies: [] },
  { name: '@riff/server', path: 'apps/server', internalDependencies: ['@riff/sdk'] },
  { name: '@riff/web', path: 'apps/web', internalDependencies: [] },
];
const manifest = (name, dependencies = {}) => ({
  name,
  private: true,
  type: 'module',
  dependencies,
});
test('accepts the declared downward workspace graph', () => {
  assert.deepEqual(
    validateWorkspaceGraph(definitions, [
      manifest('@riff/sdk'),
      manifest('@riff/server', { '@riff/sdk': 'workspace:*' }),
      manifest('@riff/web'),
    ]),
    [],
  );
});
test('rejects a runtime dependency in the public SDK', () => {
  assert.match(
    validateWorkspaceGraph(definitions, [
      manifest('@riff/sdk', { zod: 'catalog:' }),
      manifest('@riff/server'),
      manifest('@riff/web'),
    ]).join('\n'),
    /zero runtime dependencies/,
  );
});
test('rejects a browser dependency on the server', () => {
  assert.match(
    validateWorkspaceGraph(definitions, [
      manifest('@riff/sdk'),
      manifest('@riff/server'),
      manifest('@riff/web', { '@riff/server': 'workspace:*' }),
    ]).join('\n'),
    /not allowed/,
  );
});
test('checks optional and development workspace edges too', () => {
  const web = { ...manifest('@riff/web'), devDependencies: { '@riff/server': 'workspace:*' } };
  assert.match(
    validateWorkspaceGraph(definitions, [
      manifest('@riff/sdk'),
      manifest('@riff/server'),
      web,
    ]).join('\n'),
    /not allowed/,
  );
});
test('rejects workspace versions that could resolve to registry packages', () => {
  assert.match(
    validateWorkspaceGraph(definitions, [
      manifest('@riff/sdk'),
      manifest('@riff/server', { '@riff/sdk': '*' }),
      manifest('@riff/web'),
    ]).join('\n'),
    /workspace protocol/,
  );
});
