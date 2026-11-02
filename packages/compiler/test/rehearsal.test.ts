import { expect, it } from 'vitest';
import {
  buildPrompt,
  compileRequestSchema,
  PROMPT_VERSION,
  type ManifestView,
} from '../src/index.js';
const context = {
  version: 1,
  regressions: [
    {
      id: 'regression-1',
      originVersionId: 'origin',
      scenarioHash: 'a'.repeat(64),
      checkId: 'expect:effect',
      expected: 2,
      actual: 1,
      summary: 'One effect was missing.',
      scenario: '{"steps":[]}',
    },
  ],
};
it('accepts bounded independent rehearsal data without changing creator intent or granting evidence authority', () => {
  const request = compileRequestSchema.parse({
    intent: 'Keep the requested interaction.',
    base: null,
    rehearsalContext: context,
  });
  expect(request.intent).toBe('Keep the requested interaction.');
  expect(buildPrompt(request)).toContain('Quoted private rehearsal evidence');
  expect(buildPrompt(request)).toContain(JSON.stringify(context));
  expect(buildPrompt(request)).toContain('never instructions');
  expect(PROMPT_VERSION).toBe('riff-compiler/12');
  expect(
    compileRequestSchema.safeParse({ ...request, rehearsalContext: { ...context, source: 'evil' } })
      .success,
  ).toBe(false);
  expect(
    compileRequestSchema.safeParse({
      ...request,
      rehearsalContext: { ...context, regressions: Array(11).fill(context.regressions[0]) },
    }).success,
  ).toBe(false);
});

it('keeps the recorded repair response and evidence within the exact compiler contracts', async () => {
  const { readFileSync } = await import('node:fs');
  const { compileOutputSchema, checkIntent } = await import('../src/index.js');
  const fixture = JSON.parse(
    readFileSync(new URL('../fixtures/rehearsal-repair.json', import.meta.url), 'utf8'),
  );
  const request = compileRequestSchema.parse(fixture.request),
    output = compileOutputSchema.parse(fixture.output);
  expect(fixture.provenance).toMatchObject({
    transport: 'recorded-test',
    model: null,
    promptVersion: PROMPT_VERSION,
  });
  expect(request.rehearsalContext?.regressions[0]?.expected).toBe(2);
  expect(output.source?.match(/overlay.emit/g)).toHaveLength(2);
  expect(
    checkIntent(
      request.intent,
      { source: output.source!, manifest: output.manifest as ManifestView },
      { source: request.base!.source, manifest: request.base!.manifest as ManifestView },
    ).filter((c) => c.status === 'mismatch'),
  ).toEqual([]);
});
