import { describe, expect, it } from 'vitest';
import {
  checkIntent,
  compile,
  compileOffline,
  compileOutputSchema,
  COMPILE_OUTPUT_JSON_SCHEMA,
  createCompileQueue,
  createOfflineTransport,
  extractIntentHints,
  buildWorkspace,
  QueueFullError,
  type CompilerTransport,
} from '@riff/compiler';
import { SDK_GUIDE } from '@riff/sdk';

const TOMATO =
  'Let viewers throw tomatoes with !tomato, limited to three throws per person in any rolling 60 seconds.';
const EDIT = 'Change the command to !splat, allow two throws per 30 seconds, subscribers only.';

describe('intent hints', () => {
  it.each([
    [
      TOMATO,
      {
        command: 'tomato',
        maxPerViewer: 3,
        windowMs: 60_000,
        audience: ['viewer'],
        asset: 'tomato',
      },
    ],
    [
      EDIT,
      {
        command: 'splat',
        maxPerViewer: 2,
        windowMs: 30_000,
        audience: ['subscriber'],
        asset: null,
      },
    ],
    [
      'Subscribers can type !love to send a burst of three hearts, once every 30 seconds.',
      {
        command: 'love',
        maxPerViewer: 1,
        windowMs: 30_000,
        audience: ['subscriber'],
        asset: 'heart',
      },
    ],
    [
      'Let everyone use !star at most 5 per minute',
      { command: 'star', maxPerViewer: 5, windowMs: 60_000, audience: ['viewer'], asset: 'star' },
    ],
    [
      'Make it 10s and as many as four per viewer',
      { command: null, maxPerViewer: 4, windowMs: 10_000, audience: ['viewer'], asset: null },
    ],
  ])('reads only explicit facts from %s', (intent, expected) => {
    expect(extractIntentHints(intent)).toEqual(expected);
  });
  it('flags mismatches and preserved or changed aspects for edits', () => {
    const base = compileOffline({ intent: TOMATO, base: null });
    const edited = compileOffline({
      intent: EDIT,
      base: {
        title: 'Tomato Toss',
        intent: TOMATO,
        source: base.source!,
        manifest: base.manifest,
        tests: base.tests,
      },
    });
    const checks = checkIntent(EDIT, edited as never, base as never);
    expect(Object.fromEntries(checks.map((c) => [c.aspect, c.status]))).toEqual({
      command: 'match',
      allowance: 'match',
      window: 'match',
      audience: 'match',
      asset: 'preserved',
    });
    const wrong = checkIntent(TOMATO, {
      source: base.source!,
      manifest: {
        trigger: { command: '!tomato', audience: ['viewer'], maxPerViewer: 5, windowMs: 60_000 },
      },
    });
    expect(wrong.find((c) => c.aspect === 'allowance')?.status).toBe('mismatch');
  });
});

describe('structured output contract', () => {
  it('requires every property so the model cannot omit fields', () => {
    expect([...COMPILE_OUTPUT_JSON_SCHEMA.required].sort()).toEqual(
      Object.keys(COMPILE_OUTPUT_JSON_SCHEMA.properties).sort(),
    );
  });
  it('offline outputs satisfy the contract for candidates, questions and unsupported asks', () => {
    for (const intent of [
      TOMATO,
      'Throw something fun at me please',
      'Play a sound when someone types !boo',
    ])
      expect(compileOutputSchema.safeParse(compileOffline({ intent, base: null })).success).toBe(
        true,
      );
    expect(compileOffline({ intent: 'Throw something fun at me please', base: null }).kind).toBe(
      'question',
    );
    expect(
      compileOffline({ intent: 'Play a sound when someone types !boo', base: null }).kind,
    ).toBe('unsupported');
  });
  it('gives the compiler exactly the documented workspace', () => {
    const files = buildWorkspace({ intent: TOMATO, base: null });
    expect(Object.keys(files).sort()).toEqual([
      'SDK.md',
      'TASK.md',
      'examples/castle-siege.json',
      'examples/community-goal.json',
      'examples/heart-burst.json',
      'examples/shield-wall.json',
      'examples/tomato-battle.json',
      'examples/tomato-toss.json',
      'riff-test.d.ts',
      'riff.d.ts',
    ]);
    expect(files['SDK.md']).toBe(SDK_GUIDE);
    expect(files['TASK.md']).toContain('<<<REQUEST\n' + TOMATO);
  });
});

function scripted(outputs: unknown[], delayMs = 0): CompilerTransport & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    kind: 'codex',
    model: 'test-model',
    prompts,
    async open() {
      return {
        threadId: 'thread-1',
        async turn(prompt, { signal, onProgress }) {
          prompts.push(prompt);
          onProgress({ kind: 'thinking', text: 'Planning the handler' });
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, delayMs);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          });
          return {
            output: outputs.shift(),
            usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
          };
        },
        async close() {},
      };
    },
  };
}

describe('compile orchestration', () => {
  it('verifies, repairs once with the bounded report, and records provenance', async () => {
    const good = compileOffline({ intent: TOMATO, base: null });
    const bad = {
      ...good,
      manifest: {
        ...(good.manifest as object),
        trigger: { ...(good.manifest as { trigger: object }).trigger, maxPerViewer: 5 },
      },
    };
    const transport = scripted([bad, good]);
    const stages: string[] = [];
    const result = await compile({ intent: TOMATO, base: null }, transport, {
      verify: async () => ({ ok: true, failureReport: null }),
      onStage: (stage) => stages.push(stage),
    });
    expect(result.status).toBe('ready');
    expect(result.attempts).toHaveLength(2);
    expect(result.threadId).toBe('thread-1');
    expect(result.usage).toEqual({ inputTokens: 20, cachedInputTokens: 0, outputTokens: 10 });
    expect(transport.prompts[1]).toContain(
      'Per-viewer allowance: the request says 3, the candidate uses 5',
    );
    expect(stages).toEqual(['drafting', 'verifying', 'repairing', 'verifying', 'ready']);
  });
  it('stops after one repair and reports failure honestly', async () => {
    const good = compileOffline({ intent: TOMATO, base: null });
    const result = await compile({ intent: TOMATO, base: null }, scripted([good, good]), {
      verify: async () => ({ ok: false, failureReport: 'Scenario failed' }),
    });
    expect(result.status).toBe('failed');
    expect(result.attempts).toHaveLength(2);
  });
  it('passes questions through without verification', async () => {
    const question = compileOffline({ intent: 'Throw something fun at me please', base: null });
    const result = await compile(
      { intent: 'Throw something fun at me please', base: null },
      scripted([question]),
      {
        verify: async () => {
          throw new Error('must not verify');
        },
      },
    );
    expect(result.status).toBe('question');
  });
  it('cancels and times out without hanging', async () => {
    const controller = new AbortController();
    const pending = compile({ intent: TOMATO, base: null }, scripted([{}], 5_000), {
      signal: controller.signal,
      verify: async () => ({ ok: true, failureReport: null }),
    });
    controller.abort();
    expect((await pending).status).toBe('cancelled');
    const slow = await compile({ intent: TOMATO, base: null }, scripted([{}], 5_000), {
      timeoutMs: 20,
      verify: async () => ({ ok: true, failureReport: null }),
    });
    expect(slow.status).toBe('failed');
    expect(slow.error).toContain('timed out');
  });
  it('runs offline end to end through the same contract', async () => {
    const result = await compile({ intent: TOMATO, base: null }, createOfflineTransport(), {
      verify: async () => ({ ok: true, failureReport: null }),
    });
    expect(result.transport).toBe('offline');
    expect(result.final?.output?.title).toBe('Tomato Toss');
  });
});

describe('compile queue', () => {
  it('runs one job per channel and bounds waiting work', async () => {
    const queue = createCompileQueue({ perChannel: 1, global: 4, pendingPerChannel: 1 });
    let release: () => void = () => undefined;
    const first = queue.run(
      'a',
      () => new Promise<string>((resolve) => (release = () => resolve('first'))),
    );
    const second = queue.run('a', async () => 'second');
    await expect(queue.run('a', async () => 'third')).rejects.toBeInstanceOf(QueueFullError);
    expect(await queue.run('b', async () => 'other channel')).toBe('other channel');
    release();
    expect(await first).toBe('first');
    expect(await second).toBe('second');
  });
});
