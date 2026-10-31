import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /oauth:[A-Za-z0-9]{25,}/,
];
const failures = [];
for (const path of new Set(files)) {
  // Lockfiles contain public integrity hashes; these are not credentials.
  if (path.endsWith('pnpm-lock.yaml')) continue;
  const content = await readFile(path, 'utf8');
  if (patterns.some((pattern) => pattern.test(content))) failures.push(path);
}
if (failures.length) {
  console.error(`Potential secrets found in:\n${failures.join('\n')}`);
  process.exitCode = 1;
} else console.log('Focused secret checks passed. Run Gitleaks for the broader history scan.');
