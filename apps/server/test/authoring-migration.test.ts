import { expect, it } from 'vitest';
import {
  compile,
  compileOffline,
  createOfflineTransport,
  type CompilerTransport,
} from '@riff/compiler';
import { verifyAuthoredCandidate } from '../src/services/authoring/verify-migration.js';

const intent =
  'Tomato Battle: join Red with !red or Blue with !blue and !throw tomatoes, 3 throws per participant in a 120 second round; highest score wins.';
const base = compileOffline({ intent, base: null });
const request = {
  intent: 'Change the command to !splat and give each player two additional throws.',
  base: {
    title: base.title,
    intent,
    source: base.source!,
    manifest: base.manifest,
    tests: base.tests,
  },
};

it('checks structured model migrations through the same independent host pipeline as offline output', async () => {
  const output = compileOffline(request);
  const model: CompilerTransport = {
    kind: 'codex',
    model: 'recorded',
    async open() {
      return {
        threadId: 'recorded',
        async turn() {
          return { output, usage: null };
        },
        async close() {},
      };
    },
  };
  for (const transport of [model, createOfflineTransport()]) {
    const result = await compile(request, transport, {
      verify: (candidate) => verifyAuthoredCandidate(candidate, base.manifest),
    });
    expect(result.status).toBe('ready');
    expect(result.final?.output?.migrationSource).toBe(output.migrationSource);
  }
});

it.each([
  'not valid javascript',
  '(input) => ({...input.snapshot, scores: {red: 99, blue: 0}})',
  '(input) => input.snapshot',
  '(input) => { if (input.snapshot.phase === "paused") throw Error("bad pause"); return {...input.snapshot,participants:Object.fromEntries(Object.entries(input.snapshot.participants).map(([id,p])=>[id,{...p,remaining:p.remaining+2}]))}; }',
])(
  'rejects malformed or nonpreserving generated migrations before a candidate can be approved: %s',
  async (migrationSource) => {
    const output = compileOffline(request);
    const report = await verifyAuthoredCandidate(
      { source: output.source!, manifest: output.manifest, tests: output.tests, migrationSource },
      base.manifest,
    );
    expect(report.ok).toBe(false);
    expect(report.failureReport).toContain('migration');
  },
);
