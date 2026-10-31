/**
 * Opt-in live compiler check: one real Codex compile through the production transport,
 * the full sandbox verification pipeline and the intent checks. Never runs in CI.
 * Usage: pnpm compile:live ["intent"] [--edit "edit intent"]
 */
import { compile } from '@riff/compiler';
import { verifyCandidate } from '@riff/sandbox';
import { createCodexTransport } from '../src/services/authoring/codex-transport.js';

const args = process.argv.slice(2);
const editIndex = args.indexOf('--edit');
const intent =
  (editIndex === 0 ? undefined : args[0]) ??
  'Let viewers throw tomatoes with !tomato, limited to three throws per person in any rolling 60 seconds.';
const editIntent = editIndex >= 0 ? args[editIndex + 1] : undefined;
const transport = createCodexTransport({
  model: process.env.RIFF_COMPILER_MODEL || null,
  reasoningEffort: (process.env.RIFF_COMPILER_EFFORT as 'low') || 'low',
});

async function once(text: string, base: Parameters<typeof compile>[0]['base']) {
  const started = Date.now();
  const result = await compile({ intent: text, base }, transport, {
    verify: verifyCandidate,
    onStage: (stage, attempt) =>
      console.log(
        `[${((Date.now() - started) / 1000).toFixed(1)}s] stage ${stage} (attempt ${attempt})`,
      ),
    onProgress: (p) => console.log(`   ${p.kind}: ${p.text.replace(/\s+/g, ' ').slice(0, 140)}`),
  });
  const final = result.final;
  console.log(
    JSON.stringify(
      {
        status: result.status,
        threadId: result.threadId,
        durationMs: result.durationMs,
        usage: result.usage,
        attempts: result.attempts.length,
        error: result.error,
        title: final?.output?.title,
        behavior: final?.output?.behavior,
        manifest: final?.output?.manifest,
        source: final?.output?.source,
        stages: final?.verification?.stages.map((s) => `${s.id}:${s.status} ${s.summary}`),
        intent: final?.intent.map(
          (c) => `${c.aspect}:${c.status} (${c.stated ?? '-'} → ${c.actual})`,
        ),
        question: final?.output?.question,
      },
      null,
      2,
    ),
  );
  return result;
}
const first = await once(intent, null);
const output = first.final?.output;
if (editIntent && output?.kind === 'candidate') {
  await once(editIntent, {
    title: output.title,
    intent,
    source: output.source ?? '',
    manifest: output.manifest,
    tests: output.tests,
  });
}
process.exit(first.status === 'ready' ? 0 : 1);
