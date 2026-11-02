import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { findUnverified, unverifiedExitCode } from './lib/unverified.mjs';

// Tracked and untracked-but-not-ignored code, the same file set as check:secrets.
const paths = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter((path) => /\.[cm]?[jt]sx?$/.test(path));
const files = [];
for (const path of new Set(paths)) {
  // Tracked files deleted in the working tree have nothing left to count.
  const source = await readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (source !== null) files.push({ path, source });
}
const found = findUnverified(files);
for (const { path, line, text } of found) console.log(`${path}:${line}  ${text}`);
console.log(`UNVERIFIED markers: ${found.length}`);
process.exitCode = unverifiedExitCode(found, process.env);
if (process.exitCode) console.error('Release builds (RIFF_RELEASE=1) require zero markers.');
