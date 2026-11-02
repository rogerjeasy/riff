import { afterEach, describe, expect, it } from 'vitest';
import { createOfflineTransport, type CompilerTransport } from '@riff/compiler';
import { createApp, type RiffApp } from '../src/app.js';
import type { VersionView } from '../src/services/automations/views.js';
import type { LiveChatMessage } from '../src/services/live/runtime.js';

const TOMATO =
  'Let viewers throw tomatoes with !tomato, limited to three throws per person in any rolling 60 seconds.';
const EDIT = 'Change the command to !splat, allow two throws per 30 seconds, subscribers only.';
const headers = { 'x-riff-request': '1' };
type App = RiffApp;
const apps: App[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function boot(transport?: CompilerTransport) {
  const app = await createApp({ logger: false, ...(transport ? { transport } : {}) });
  apps.push(app);
  return app;
}
/**
 * The offline compiler, except that every edit (a request with a base version) yields a
 * candidate that cannot compile, on the first draft and on the single repair alike.
 */
function brokenEdits(): CompilerTransport & { turns: () => number } {
  const offline = createOfflineTransport({ delayMs: 0 });
  let turns = 0;
  return {
    kind: offline.kind,
    model: offline.model,
    turns: () => turns,
    async open(request, files, options) {
      const session = await offline.open(request, files, options);
      if (!request.base) return session;
      return {
        threadId: session.threadId,
        close: () => session.close(),
        async turn(prompt, turnOptions) {
          turns++;
          const turn = await session.turn(prompt, turnOptions);
          const output = turn.output as { kind?: string; source?: string };
          return output.kind === 'candidate'
            ? { ...turn, output: { ...output, source: `${output.source}\nexport const = ;` } }
            : turn;
        },
      };
    },
  };
}
async function generate(app: App, intent: string, baseVersionId: string | null = null) {
  const started = await app.inject({
    method: 'POST',
    url: '/api/compile-runs',
    headers,
    payload: { intent, baseVersionId },
  });
  expect(started.statusCode).toBe(202);
  const id = started.json<{ id: string }>().id;
  for (let i = 0; i < 200; i++) {
    const run = app.riff.authoring.runs().find((r) => r.id === id);
    if (run?.result) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('generation did not finish');
}
async function studio(app: App) {
  return (await app.inject({ method: 'GET', url: '/api/studio' })).json<{
    panic: boolean;
    automations: {
      id: string;
      activeVersionId: string | null;
      status: string;
      versions: VersionView[];
    }[];
    activity: { code: string | null; message: string }[];
  }>();
}
const chat = (
  id: string,
  viewer: string,
  text: string,
  roles: LiveChatMessage['roles'] = ['viewer'],
): LiveChatMessage => ({
  id,
  channelId: 'broadcaster-1',
  viewerId: `user-${viewer}`,
  viewerName: viewer,
  roles,
  text,
  source: 'twitch',
});
function fakeOverlay(app: App) {
  const received: { type: string; payload: { asset?: string } }[] = [];
  app.riff.overlay.attach(
    { send: (data) => received.push(JSON.parse(data)), close: () => undefined },
    'home',
  );
  return () => received.filter((m) => m.type === 'effect');
}

describe('describe → test → preview → approve → play', () => {
  it('turns a sentence into verified evidence, previews privately and activates the exact version', async () => {
    const app = await boot();
    const effects = fakeOverlay(app);
    const run = await generate(app, TOMATO);
    expect(run.result?.status).toBe('ready');
    const [automation] = (await studio(app)).automations;
    const candidate = automation!.versions[0]!;
    expect(candidate.status).toBe('candidate');
    expect(candidate.evidence.verification.ok).toBe(true);
    expect(candidate.evidence.verification.stages.every((s) => s.status === 'passed')).toBe(true);
    expect(
      candidate.evidence.intent.filter((c) => c.status === 'match').map((c) => c.aspect),
    ).toEqual(expect.arrayContaining(['command', 'allowance', 'window', 'audience', 'asset']));
    expect(candidate.blockers).toEqual([]);

    // Private preview: decisions come back over HTTP, nothing reaches the live overlay.
    const events = [0, 1, 2, 3].map((i) => ({
      id: `p${i}`,
      channelId: 'preview',
      viewerId: 'alice',
      roles: ['viewer'],
      text: '!tomato',
      at: i,
    }));
    events.push({
      id: 'p4',
      channelId: 'preview',
      viewerId: 'bob',
      roles: ['viewer'],
      text: '!tomato',
      at: 5,
    });
    events.push({
      id: 'p0',
      channelId: 'preview',
      viewerId: 'alice',
      roles: ['viewer'],
      text: '!tomato',
      at: 6,
    });
    const preview = await app.inject({
      method: 'POST',
      url: `/api/versions/${candidate.id}/preview`,
      headers,
      payload: { seed: 42, events },
    });
    expect(
      preview.json<{ decisions: { code: string; mode: string }[] }>().decisions.map((d) => d.code),
    ).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'VIEWER_LIMIT', 'ACCEPTED', 'DUPLICATE']);
    expect(
      preview
        .json<{ decisions: { mode: string }[] }>()
        .decisions.every((d) => d.mode === 'preview'),
    ).toBe(true);
    expect(effects()).toHaveLength(0);

    // Approval must name the reviewed artifact and the expected active version.
    const wrong = await app.inject({
      method: 'POST',
      url: `/api/versions/${candidate.id}/approve`,
      headers,
      payload: { artifactId: 'f'.repeat(64), expectedActiveVersionId: null },
    });
    expect(wrong.statusCode).toBe(409);
    const approved = await app.inject({
      method: 'POST',
      url: `/api/versions/${candidate.id}/approve`,
      headers,
      payload: { artifactId: candidate.artifactId, expectedActiveVersionId: null },
    });
    expect(approved.statusCode).toBe(200);

    // Real (normalized, authenticated) chat drives the approved version.
    const codes = [];
    for (let i = 0; i < 4; i++)
      codes.push((await app.riff.runtime.handleChat(chat(`m${i}`, 'alice', '!tomato')))[0]?.code);
    codes.push((await app.riff.runtime.handleChat(chat('m4', 'bob', '!tomato')))[0]?.code);
    codes.push((await app.riff.runtime.handleChat(chat('m0', 'alice', '!tomato')))[0]?.code);
    expect(codes).toEqual([
      'ACCEPTED',
      'ACCEPTED',
      'ACCEPTED',
      'VIEWER_LIMIT',
      'ACCEPTED',
      'DUPLICATE',
    ]);
    expect(effects()).toHaveLength(4);
    expect((await studio(app)).automations[0]?.status).toBe('live');
  }, 60_000);

  it('edits command, cooldown and audience through the same pipeline, keeps allowances, and rolls back', async () => {
    const app = await boot();
    const effects = fakeOverlay(app);
    await generate(app, TOMATO);
    const v1 = (await studio(app)).automations[0]!.versions[0]!;
    await app.inject({
      method: 'POST',
      url: `/api/versions/${v1.id}/approve`,
      headers,
      payload: { artifactId: v1.artifactId, expectedActiveVersionId: null },
    });
    for (let i = 0; i < 3; i++)
      await app.riff.runtime.handleChat(
        chat(`a${i}`, 'alice', '!tomato', ['viewer', 'subscriber']),
      );

    const edit = await generate(app, EDIT, v1.id);
    expect(edit.result?.status).toBe('ready');
    const automation = (await studio(app)).automations[0]!;
    const v2 = automation.versions.find((v) => v.status === 'candidate')!;
    expect(v2.number).toBe(2);
    expect(
      Object.fromEntries(v2.changes.map((c) => [c.field, [c.from, c.to, c.authority]])),
    ).toMatchObject({
      command: ['!tomato', '!splat', 'same'],
      audience: ['everyone', 'subscribers', 'less'],
      maxPerViewer: ['3', '2', 'less'],
      windowMs: ['1 min', '30 s', 'more'],
    });
    expect(v2.evidence.intent.find((c) => c.aspect === 'asset')?.status).toBe('preserved');
    expect(v2.evidence.verification.host.some((s) => s.kind === 'role')).toBe(true);

    // Stale approval: the expected active version must match.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/versions/${v2.id}/approve`,
          headers,
          payload: { artifactId: v2.artifactId, expectedActiveVersionId: null },
        })
      ).statusCode,
    ).toBe(409);
    await app.inject({
      method: 'POST',
      url: `/api/versions/${v2.id}/approve`,
      headers,
      payload: { artifactId: v2.artifactId, expectedActiveVersionId: v1.id },
    });

    expect(
      (await app.riff.runtime.handleChat(chat('b0', 'bob', '!tomato', ['viewer', 'subscriber'])))[0]
        ?.code,
    ).toBe('UNRELATED');
    expect(
      (await app.riff.runtime.handleChat(chat('b1', 'carol', '!splat', ['viewer'])))[0]?.code,
    ).toBe('AUDIENCE');
    // Alice spent 3 actions under v1; the shared counter blocks her under v2 (limit 2).
    expect(
      (
        await app.riff.runtime.handleChat(chat('b2', 'alice', '!splat', ['viewer', 'subscriber']))
      )[0]?.code,
    ).toBe('VIEWER_LIMIT');
    expect(
      (await app.riff.runtime.handleChat(chat('b3', 'sam', '!SPLAT', ['viewer', 'subscriber'])))[0]
        ?.code,
    ).toBe('ACCEPTED');

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/automations/${automation.id}/rollback`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    const after = (await studio(app)).automations[0]!;
    expect(after.activeVersionId).toBe(v1.id);
    expect((await app.riff.runtime.handleChat(chat('c0', 'dan', '!tomato')))[0]?.code).toBe(
      'ACCEPTED',
    );
    expect(effects()).toHaveLength(5);
  }, 60_000);

  it('A12: a failed edit compile and repair leaves the live version, engine and chat untouched', async () => {
    const transport = brokenEdits();
    const app = await boot(transport);
    const effects = fakeOverlay(app);
    await generate(app, TOMATO);
    const v1 = (await studio(app)).automations[0]!.versions[0]!;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/versions/${v1.id}/approve`,
          headers,
          payload: { artifactId: v1.artifactId, expectedActiveVersionId: null },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.riff.runtime.handleChat(chat('l0', 'alice', '!tomato')))[0]?.code).toBe(
      'ACCEPTED',
    );
    const running = app.riff.runtime.running();
    expect(running).toEqual([
      expect.objectContaining({ versionId: v1.id, artifactId: v1.artifactId }),
    ]);

    const edit = await generate(app, EDIT, v1.id);
    expect(edit.result?.status).toBe('failed');
    // Exactly one draft and one repair, both rejected by host verification.
    expect(transport.turns()).toBe(2);
    const failedRun = app.riff.repo.runs().find((r) => r.id === edit.id)!;
    expect(failedRun.attempts as unknown[]).toHaveLength(2);

    const automation = (await studio(app)).automations[0]!;
    expect(automation.activeVersionId).toBe(v1.id);
    expect(automation.status).toBe('live');
    expect(automation.versions.find((v) => v.id === v1.id)?.status).toBe('active');
    const failed = automation.versions.filter((v) => v.id !== v1.id);
    expect(failed).toHaveLength(1);
    expect(failed.every((v) => v.status !== 'active' && !v.evidence.verification.ok)).toBe(true);
    // The very same engine keeps running the approved artifact.
    expect(app.riff.runtime.running()).toEqual(running);

    // Live chat still dispatches through v1: its command, its allowance, its effects.
    const codes = [];
    for (let i = 1; i < 4; i++)
      codes.push((await app.riff.runtime.handleChat(chat(`l${i}`, 'alice', '!tomato')))[0]?.code);
    codes.push((await app.riff.runtime.handleChat(chat('l4', 'bob', '!splat')))[0]?.code);
    codes.push((await app.riff.runtime.handleChat(chat('l5', 'bob', '!tomato')))[0]?.code);
    expect(codes).toEqual(['ACCEPTED', 'ACCEPTED', 'VIEWER_LIMIT', 'UNRELATED', 'ACCEPTED']);
    expect(effects()).toHaveLength(4);
  }, 60_000);

  it('emergency stop works from chat and console, clears the overlay and survives until resumed', async () => {
    const app = await boot();
    const received: { type: string }[] = [];
    app.riff.overlay.attach(
      { send: (data) => received.push(JSON.parse(data)), close: () => undefined },
      'home',
    );
    await generate(app, TOMATO);
    const v1 = (await studio(app)).automations[0]!.versions[0]!;
    await app.inject({
      method: 'POST',
      url: `/api/versions/${v1.id}/approve`,
      headers,
      payload: { artifactId: v1.artifactId, expectedActiveVersionId: null },
    });

    await app.riff.runtime.handleChat(chat('x0', 'troll', '!riff panic'));
    expect(app.riff.runtime.panicked).toBe(false); // viewers cannot stop the channel
    await app.riff.runtime.handleChat(chat('x1', 'mod', '!riff panic', ['viewer', 'moderator']));
    expect(app.riff.runtime.panicked).toBe(true);
    expect(received.some((m) => m.type === 'clear')).toBe(true);
    expect(await app.riff.runtime.handleChat(chat('x2', 'alice', '!tomato'))).toEqual([]);
    expect(app.riff.repo.state().panic).toBe(true);
    expect((await studio(app)).automations[0]!.versions[0]!.blockers).toContain(
      'Everything is stopped. Resume the channel first.',
    );

    expect(
      (await app.inject({ method: 'POST', url: '/api/channel/resume', headers, payload: {} }))
        .statusCode,
    ).toBe(400);
    await app.inject({
      method: 'POST',
      url: '/api/channel/resume',
      headers,
      payload: { confirm: true },
    });
    expect((await app.riff.runtime.handleChat(chat('x3', 'alice', '!tomato')))[0]?.code).toBe(
      'ACCEPTED',
    );
    await app.inject({ method: 'POST', url: '/api/channel/panic', headers });
    expect(app.riff.runtime.panicked).toBe(true);
  }, 60_000);

  it('quarantines a misbehaving live version and records an actionable incident', async () => {
    const app = await boot();
    await generate(app, TOMATO);
    const v1 = (await studio(app)).automations[0]!.versions[0]!;
    await app.inject({
      method: 'POST',
      url: `/api/versions/${v1.id}/approve`,
      headers,
      payload: { artifactId: v1.artifactId, expectedActiveVersionId: null },
    });
    // Simulate a version whose handler faults at runtime by activating a hostile artifact directly.
    app.riff.runtime.activate(v1.automationId, {
      ...v1,
      source: '() => { throw new Error("boom") }',
    } as never);
    expect((await app.riff.runtime.handleChat(chat('q0', 'alice', '!tomato')))[0]?.code).toBe(
      'INCIDENT',
    );
    const after = await studio(app);
    expect(after.automations[0]!.status).toBe('paused');
    expect(
      after.activity.some((a) => a.code === 'INCIDENT' && a.message.includes('rollback')),
    ).toBe(true);
  }, 60_000);

  it('answers unsupported and ambiguous requests honestly instead of guessing', async () => {
    const app = await boot();
    expect(
      (await generate(app, 'Play a loud sound whenever someone types !boo')).result?.status,
    ).toBe('unsupported');
    const question = await generate(app, 'Throw something fun at my camera please');
    expect(question.result?.status).toBe('question');
    expect(question.result?.choices.length).toBeGreaterThan(1);
    expect((await studio(app)).automations).toHaveLength(0);
  }, 30_000);

  it('authenticates overlay sockets with the rotatable key', async () => {
    const app = await boot();
    await app.ready();
    const key = app.riff.repo.state().overlayKey;
    const bad = await app.injectWS('/ws/overlay?key=wrong');
    const closed = await new Promise<number>((resolve) => bad.on('close', (code) => resolve(code)));
    expect(closed).toBe(4001);
    const messages: string[] = [];
    const good = await app.injectWS(
      `/ws/overlay?key=${key}`,
      {},
      {
        onInit: (ws) => ws.on('message', (data) => messages.push(String(data))),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(JSON.parse(messages[0] ?? '{}')).toMatchObject({ v: 1, type: 'hello' });
    expect(JSON.parse(messages[1] ?? '{}')).toMatchObject({ v: 1, type: 'instructions' });
    const rotated = await app.inject({ method: 'POST', url: '/api/overlay/rotate', headers });
    expect(rotated.json<{ url: string }>().url).not.toContain(key);
    good.terminate();
  });
});
