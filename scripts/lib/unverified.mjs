// The AGENTS.md §5 marker for a Twitch/Codex detail not checked against docs or
// fixtures. Written with escapes so this file never matches itself.
const MARKER = /\/\/\s*UNVERIFIED:/;

/** Every marker in the given files, as `{ path, line, text }` with a 1-based line. */
export function findUnverified(files) {
  const found = [];
  for (const { path, source } of files) {
    source.split('\n').forEach((text, index) => {
      if (MARKER.test(text)) found.push({ path, line: index + 1, text: text.trim() });
    });
  }
  return found;
}

/** Markers are reported always, but only block a release build (`RIFF_RELEASE=1`). */
export function unverifiedExitCode(found, env) {
  return env.RIFF_RELEASE === '1' && found.length > 0 ? 1 : 0;
}
