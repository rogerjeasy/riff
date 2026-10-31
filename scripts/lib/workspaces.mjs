/** Validate the public package graph without loading product code or dependencies. */
export function validateWorkspaceGraph(definitions, manifests) {
  const errors = [];
  const names = new Set(definitions.map(({ name }) => name));
  for (const definition of definitions) {
    const manifest = manifests.find(({ name }) => name === definition.name);
    if (!manifest) {
      errors.push(`Missing manifest for ${definition.name}`);
      continue;
    }
    if (!manifest.private || manifest.type !== 'module') {
      errors.push(`${definition.name} must be private and use ESM`);
    }
    if (
      definition.name === '@riff/sdk' &&
      Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      }).length
    ) {
      errors.push('@riff/sdk must have zero runtime dependencies');
    }
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (name.startsWith('@riff/') && !names.has(name)) errors.push(`Unknown workspace ${name}`);
        if (!names.has(name)) continue;
        if (!definition.internalDependencies.includes(name))
          errors.push(`${definition.name} → ${name} is not allowed`);
        if (!version.startsWith('workspace:'))
          errors.push(`${definition.name} → ${name} must use the workspace protocol`);
      }
    }
  }
  return errors;
}
