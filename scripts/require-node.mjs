const [major, minor, patch] = process.versions.node.split('.').map(Number);
if (major !== 22 || minor < 23 || (minor === 23 && patch < 2)) {
  console.error('Riff requires Node 22.23.2 or a newer Node 22 patch. Run nvm use.');
  process.exitCode = 1;
}
