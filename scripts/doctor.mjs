import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tools = JSON.parse(await readFile(resolve(root, 'config/tooling.json'), 'utf8'));
const workspaces = JSON.parse(await readFile(resolve(root, 'config/workspaces.json'), 'utf8'));
let missing = 0;
console.log('System tools (conditional tools do not block local application development):');
for (const tool of tools) {
  const result = spawnSync(tool.command, tool.args, {
    encoding: 'utf8',
    timeout: 10000,
    shell: false,
  });
  const available = !result.error && result.status === 0;
  console.log(
    `  ${available ? 'available' : 'unavailable'}: ${tool.name} [${tool.role}]${available ? ` — ${result.stdout.trim().split('\n')[0]}` : ''}`,
  );
  if (!available && tool.role === 'required') missing++;
}
console.log('\nWorkspace dependencies:');
for (const { path, name } of [{ path: '.', name: 'riff-workspace' }, ...workspaces]) {
  const manifest = JSON.parse(await readFile(resolve(root, path, 'package.json'), 'utf8'));
  const expected = { ...manifest.dependencies, ...manifest.devDependencies };
  const absent = [];
  for (const dependency of Object.keys(expected)) {
    try {
      await readFile(resolve(root, path, 'node_modules', dependency, 'package.json'));
    } catch {
      absent.push(dependency);
    }
  }
  console.log(
    `  ${name}: ${absent.length ? `missing ${absent.join(', ')}` : `${Object.keys(expected).length} direct dependencies present`}`,
  );
  missing += absent.length;
}
if (!process.versions.node.startsWith('22.')) {
  console.error('Use the Node 22 version pinned in .nvmrc.');
  missing++;
}
console.log(
  '\nRun setup:verify for behavioral checks. Tool presence does not prove daemon, account, or integration readiness.',
);
process.exitCode = missing ? 1 : 0;
