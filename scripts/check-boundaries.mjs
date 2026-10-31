import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateWorkspaceGraph } from './lib/workspaces.mjs';
import { findSourceBoundaryErrors } from './lib/source-boundaries.mjs';
import { sourceFiles } from './lib/files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const definitions = JSON.parse(await readFile(resolve(root, 'config/workspaces.json'), 'utf8'));
const manifests = await Promise.all(
  definitions.map(async ({ path }) =>
    JSON.parse(await readFile(resolve(root, path, 'package.json'), 'utf8')),
  ),
);
const errors = validateWorkspaceGraph(definitions, manifests);
for (const { path } of definitions) {
  for (const filePath of await sourceFiles(resolve(root, path, 'src'))) {
    errors.push(
      ...findSourceBoundaryErrors({
        root,
        filePath,
        source: await readFile(filePath, 'utf8'),
        definitions,
      }),
    );
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log(`Workspace boundaries verified for ${definitions.length} packages.`);
