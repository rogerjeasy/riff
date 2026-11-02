import assert from 'node:assert/strict';
import test from 'node:test';
import { findUnverified, unverifiedExitCode } from '../lib/unverified.mjs';

// Assembled so this file is not itself counted by the repository scan.
const MARK = '// ' + 'UNVERIFIED:';

test('lists each marker with its file and 1-based line', () => {
  const found = findUnverified([
    { path: 'a.ts', source: `const a = 1;\n${MARK} shape not documented\n` },
    { path: 'b.ts', source: `let b = 2; ${MARK} trailing comment\n` },
    { path: 'c.ts', source: 'const unverified = "UNVERIFIED";\n' },
  ]);
  assert.deepEqual(found, [
    { path: 'a.ts', line: 2, text: `${MARK} shape not documented` },
    { path: 'b.ts', line: 1, text: `let b = 2; ${MARK} trailing comment` },
  ]);
});

test('ignores mentions that are not the comment marker', () => {
  assert.deepEqual(
    findUnverified([{ path: 'd.md', source: 'Markers look like `UNVERIFIED:` in prose.\n' }]),
    [],
  );
});

test('fails only for a release build with markers left', () => {
  const one = [{ path: 'a.ts', line: 1, text: MARK }];
  assert.equal(unverifiedExitCode(one, {}), 0);
  assert.equal(unverifiedExitCode(one, { RIFF_RELEASE: '0' }), 0);
  assert.equal(unverifiedExitCode(one, { RIFF_RELEASE: '1' }), 1);
  assert.equal(unverifiedExitCode([], { RIFF_RELEASE: '1' }), 0);
});
