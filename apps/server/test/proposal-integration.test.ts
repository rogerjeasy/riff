import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileOffline, createOfflineTransport, type CompilerTransport } from '@riff/compiler';
import { artifactIdentity } from '@riff/sandbox';
import { normalizeChatMessage } from '@riff/twitch';
import { createApp, migrateConnection, type RiffApp } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import type { RunSnapshot } from '../src/services/authoring/service.js';
import { communityProjection } from '../src/services/proposals/projection.js';
import { forChannel } from '../src/db/repositories/studio.js';
const headers = { 'x-riff-request': '1' };
const apps: RiffApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const cleanup of cleanups.splice(0)) cleanup();
});
async function setup(transport?: CompilerTransport) {
  const directory = mkdtempSync(join(tmpdir(), 'riff-audience-'));
  const path = join(directory, 'studio.db');
  let database = openDatabase(path);
  migrateConnection(database);
  let app = await createApp({ logger: false, database, ...(transport ? { transport } : {}) });
  apps.push(app);
  cleanups.push(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get app() {
      return app;
    },
    get database() {
      return database;
    },
    async restart() {
      await app.close();
      apps.splice(apps.indexOf(app), 1);
      database.close();
      database = openDatabase(path);
      app = await createApp({ logger: false, database, ...(transport ? { transport } : {}) });
      apps.push(app);
      return app;
    },
  };
}
const fixture = JSON.parse(
  readFileSync(
    new URL('../../../packages/twitch/fixtures/channel.chat.message.json', import.meta.url),
    'utf8',
  ),
) as { event: Record<string, unknown> };
async function chat(
  app: RiffApp,
  text: string,
  eventId: string = crypto.randomUUID(),
  accountId = 'viewer',
  roles: string[] = ['viewer'],
) {
  const normalized = normalizeChatMessage(
    {
      ...fixture.event,
      chatter_user_id: accountId,
      chatter_user_name: 'Private viewer',
      badges: roles.filter((r) => r !== 'viewer').map((set_id) => ({ set_id, id: '1', info: '' })),
      message: {
        text,
        fragments: [{ type: 'text', text, cheermote: null, emote: null, mention: null }],
      },
    },
    { messageId: eventId, receivedAt: Date.now() },
  );
  expect(normalized).not.toBeNull();
  return app.riff.runtime.handleChat({
    ...normalized!,
    roles: [...normalized!.roles],
    source: 'twitch',
  });
}
async function post(app: RiffApp, url: string, payload: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url, headers, payload });
}
async function select(
  app: RiffApp,
  baseVersionId: string | null = null,
  text = 'Change the command to !splat and give each player two additional throws.',
) {
  await chat(app, `!riff suggest ${text}`);
  const p = app.riff.proposals.snapshot().proposals[0]!;
  expect(
    (
      await post(app, `/api/proposals/${p.id}/moderate`, {
        expectedRevision: p.revision,
        action: 'shortlist',
      })
    ).statusCode,
  ).toBe(200);
  const response = await post(app, `/api/proposals/${p.id}/select`, {
    expectedRevision: p.revision + 1,
    brief: text,
    baseVersionId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return {
    proposalId: p.id,
    selection: response.json().selection as { id: string; proposalRevision: number },
  };
}
async function waitRun(app: RiffApp, runId: string) {
  await vi.waitFor(
    () => expect(app.riff.repo.run(runId)?.status).toMatch(/^(ready|failed|cancelled)$/),
    { timeout: 20000, interval: 20 },
  );
  return app.riff.repo.run(runId)!;
}
describe('audience proposal integration', () => {
  it('consumes normalized reserved chat privately before automation dispatch and requires creator selection', async () => {
    const { app } = await setup();
    await chat(app, '!riff suggest private unreviewed idea', 'suggest-1');
    const response = await app.inject('/api/proposals');
    expect(response.statusCode).toBe(200);
    const data = response.json();
    expect(data.proposals).toHaveLength(1);
    expect(JSON.stringify(data.publicProjection)).not.toContain('private unreviewed idea');
    expect(app.riff.authoring.runs()).toHaveLength(0);
    expect(app.riff.repo.activity()).toHaveLength(0);
    const p = data.proposals[0];
    expect(
      (
        await post(app, `/api/proposals/${p.id}/select`, {
          expectedRevision: 0,
          brief: 'A reviewed audience idea',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/proposals/${p.id}/moderate`,
          payload: { expectedRevision: 0, action: 'shortlist' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await post(app, `/api/proposals/${p.id}/moderate`, {
          expectedRevision: 0,
          action: 'shortlist',
          actor: { kind: 'creator' },
        })
      ).statusCode,
    ).toBe(400);
    await chat(app, `!riff shortlist ${p.id}`, 'mod-denied', 'moderator', ['moderator']);
    expect(app.riff.proposals.snapshot().proposals[0]!.state).toBe('pending');
    expect(
      (await post(app, '/api/proposals/grants', { accountId: 'moderator', enabled: true }))
        .statusCode,
    ).toBe(200);
    await chat(app, `!riff shortlist ${p.id}`, 'mod-granted', 'moderator', ['moderator']);
    expect(app.riff.proposals.snapshot().proposals[0]!.state).toBe('shortlisted');
    await chat(app, '!riff unknown private content');
    await chat(app, '!riff panic', 'panic', 'moderator', ['moderator']);
    expect(app.riff.runtime.panicked).toBe(true);
    expect(app.riff.authoring.runs()).toHaveLength(0);
  });
  it('claims generation durably once, suppresses a hidden in-flight result, and keeps replay idempotent after restart', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const offline = createOfflineTransport();
    let calls = 0;
    let signal: AbortSignal | undefined;
    const transport: CompilerTransport = {
      kind: 'offline',
      model: null,
      async open(request, files) {
        calls++;
        const session = await offline.open(request, files);
        return {
          ...session,
          async turn(prompt, options) {
            signal = options.signal;
            await gate;
            return session.turn(prompt, options);
          },
        };
      },
    };
    const f = await setup(transport);
    const { selection, proposalId } = await select(f.app);
    const first = await post(f.app, `/api/proposals/selections/${selection.id}/generate`);
    expect(first.statusCode, first.body).toBe(202);
    const run = first.json() as RunSnapshot;
    expect(
      (await post(f.app, `/api/proposals/selections/${selection.id}/generate`)).json().id,
    ).toBe(run.id);
    await vi.waitFor(() => expect(calls).toBe(1));
    await post(f.app, `/api/proposals/${proposalId}/moderate`, {
      expectedRevision: selection.proposalRevision,
      action: 'hide',
    });
    expect(signal!.aborted).toBe(true);
    release();
    await waitRun(f.app, run.id);
    expect(f.app.riff.repo.versions()).toHaveLength(0);
    expect(
      JSON.stringify(communityProjection(f.app.riff.proposals, f.app.riff.repo)),
    ).not.toContain('two additional');
    await f.restart();
    expect(
      (await post(f.app, `/api/proposals/selections/${selection.id}/generate`)).json().id,
    ).toBe(run.id);
    expect(calls).toBe(1);
  });
  it('caches only currently moderated community content across rotation and suppresses updates while panicked', async () => {
    const { app } = await setup();
    const { selection, proposalId } = await select(app);
    const frames: string[] = [];
    const socket = { send: (frame: string) => frames.push(frame), close: () => {} };
    app.riff.overlay.attach(socket, 'home');
    expect(frames.some((s) => s.includes('two additional'))).toBe(true);
    app.riff.overlay.disconnectAll();
    frames.length = 0;
    app.riff.overlay.attach(socket, 'home');
    expect(frames.some((s) => s.includes('two additional'))).toBe(true);
    await chat(app, '!riff credit on');
    expect(JSON.stringify(communityProjection(app.riff.proposals, app.riff.repo))).toContain(
      'Private viewer',
    );
    await chat(app, '!riff credit off');
    frames.length = 0;
    app.riff.overlay.attach(socket, 'home');
    expect(frames.some((s) => s.includes('Private viewer'))).toBe(false);
    const projectionRead = vi
      .spyOn(app.riff.proposals, 'publicProjection')
      .mockImplementationOnce(() => {
        throw Error('read unavailable');
      });
    app.riff.hub.publish('studio', null);
    projectionRead.mockRestore();
    frames.length = 0;
    app.riff.overlay.attach(socket, 'home');
    expect(frames.some((s) => s.includes('two additional'))).toBe(false);
    app.riff.hub.publish('studio', null);
    app.riff.studio.panic('test');
    frames.length = 0;
    app.riff.overlay.setCommunity(communityProjection(app.riff.proposals, app.riff.repo));
    app.riff.overlay.attach(socket, 'home');
    expect(frames.some((s) => s.includes('two additional'))).toBe(false);
    await post(app, `/api/proposals/${proposalId}/moderate`, {
      expectedRevision: selection.proposalRevision,
      action: 'hide',
    });
    await post(app, '/api/channel/resume', { confirm: true });
    frames.length = 0;
    app.riff.overlay.attach(socket, 'home');
    expect(frames.some((s) => s.includes('two additional'))).toBe(false);
  });
});
const battleIntent =
  'Tomato Battle: join Red with !red or Blue with !blue and !throw tomatoes, 3 throws per participant in a 120 second round; highest score wins.';
async function battle(app: RiffApp) {
  const output = compileOffline({ intent: battleIntent, base: null });
  const automation = app.riff.repo.createAutomation(output.title);
  const base = app.riff.repo.insertVersion({
    automationId: automation.id,
    parentVersionId: null,
    artifactId: artifactIdentity({ source: output.source!, manifest: output.manifest }),
    title: output.title,
    intent: battleIntent,
    source: output.source!,
    manifest: output.manifest,
    tests: output.tests,
    behavior: output.behavior,
    assumptions: output.assumptions,
    evidence: { verification: { ok: true }, intent: [] },
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
  app.riff.repo.activate(automation.id, base.id);
  app.riff.runtime.activate(automation.id, app.riff.repo.version(base.id)!);
  await chat(app, '!red', 'join');
  await chat(app, '!throw', 'throw');
  const selected = await select(app, base.id);
  const response = await post(app, `/api/proposals/selections/${selected.selection.id}/generate`);
  expect(response.statusCode, response.body).toBe(202);
  const run = await waitRun(app, response.json().id);
  expect(run.status, run.error ?? '').toBe('ready');
  const next = app.riff.repo.version(run.versionId!)!;
  async function preview(boundary = 'immediate') {
    const r = await post(app, `/api/versions/${next.id}/transition/preview`, { boundary });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().transition;
  }
  const approve = (transition: Record<string, unknown>) =>
    post(app, `/api/transitions/${transition.id}/approve`, {
      evidenceId: transition.evidenceId,
      artifactId: next.artifactId,
      expectedActiveVersionId: base.id,
      sessionId: app.riff.repo.session(automation.id)!.id,
      boundary: (transition.plan as { boundary: string }).boundary,
    });
  return { ...selected, automation, base, next, preview, approve };
}
it('runs the selected !splat +2 edit through F32 with preserved scores and audit, then blocks revoked activation and descendant edits', async () => {
  const { app } = await setup(createOfflineTransport());
  const f = await battle(app);
  const before = app.riff.repo.session(f.automation.id)!.snapshot;
  expect(before.scores.red).toBe(1);
  expect(before.participants.viewer!.remaining).toBe(2);
  const transition = await f.preview();
  expect((await f.approve(transition)).statusCode).toBe(200);
  const current = app.riff.repo.session(f.automation.id)!.snapshot;
  expect(current.scores).toEqual(before.scores);
  expect(current.participants.viewer!.remaining).toBe(4);
  expect((await app.riff.studio.auditSession(f.automation.id)).status).toBe('verified');
  expect(communityProjection(app.riff.proposals, app.riff.repo).selections[0]!.status).toBe(
    'applied',
  );
  const edit = app.riff.authoring.start({
    intent: 'Keep the command !splat and show heart projectiles instead.',
    baseVersionId: f.next.id,
  });
  const editRun = await waitRun(app, edit.id);
  expect(editRun.status, editRun.error ?? '').toBe('ready');
  const descendant = app.riff.repo.version(editRun.versionId!)!;
  await post(app, `/api/proposals/${f.proposalId}/moderate`, {
    expectedRevision: f.selection.proposalRevision,
    action: 'hide',
  });
  // Moderation preserves existing play, but every future activation remains gated.
  expect(app.riff.repo.automation(f.automation.id)!.activeVersionId).toBe(f.next.id);
  expect((await chat(app, '!splat', 'after-hide'))[0]!.code).toBe('ACCEPTED');
  expect(() => app.riff.repo.activate(f.automation.id, descendant.id)).toThrow('REVOKED');
  expect(() => app.riff.repo.activate(f.automation.id, f.next.id)).toThrow('REVOKED');
  expect(
    (
      await post(app, `/api/versions/${descendant.id}/approve`, {
        artifactId: descendant.artifactId,
        expectedActiveVersionId: f.next.id,
      })
    ).statusCode,
  ).toBe(409);
  app.riff.studio.pause(f.automation.id);
  expect((await post(app, `/api/automations/${f.automation.id}/resume`)).statusCode).toBe(409);
  expect(
    (
      await post(app, '/api/compile-runs', {
        intent: 'Keep the !splat command and display a tomato.',
        baseVersionId: descendant.id,
      })
    ).statusCode,
  ).toBe(409);
  // Clean pre-proposal rollback remains safe; restoring the removed target stays blocked.
  app.riff.repo.activate(f.automation.id, f.base.id);
  expect(() => app.riff.repo.activate(f.automation.id, f.next.id)).toThrow('REVOKED');
}, 30000);
it('cancels F32 round-end reviews on hide without disturbing current live progress', async () => {
  const { app } = await setup(createOfflineTransport());
  const f = await battle(app);
  const transition = await f.preview('round-end');
  expect((await f.approve(transition)).statusCode).toBe(200);
  expect(app.riff.repo.transition(transition.id)!.status).toBe('pending');
  const before = app.riff.repo.session(f.automation.id);
  await post(app, `/api/proposals/${f.proposalId}/moderate`, {
    expectedRevision: f.selection.proposalRevision,
    action: 'hide',
  });
  expect(app.riff.repo.transition(transition.id)!.status).toBe('cancelled');
  expect(app.riff.repo.session(f.automation.id)).toEqual(before);
  expect((await f.approve(transition)).statusCode).toBe(409);
}, 30000);
it.each(['await', 'CAS'] as const)(
  'checks removed lineage independently at activation %s boundary',
  async (boundary) => {
    const { app } = await setup(createOfflineTransport());
    const f = await battle(app);
    const transition = await f.preview();
    const before = app.riff.repo.session(f.automation.id);
    const hide = () =>
      app.riff.proposals.moderate(
        { kind: 'creator' },
        {
          proposalId: f.proposalId,
          expectedRevision: f.selection.proposalRevision,
          action: 'hide',
        },
      );
    if (boundary === 'CAS') {
      const original = app.riff.repo.commitTransition.bind(app.riff.repo);
      const spy = vi.spyOn(app.riff.repo, 'commitTransition').mockImplementationOnce((...args) => {
        hide();
        return original(...args);
      });
      expect((await f.approve(transition)).statusCode).toBe(409);
      spy.mockRestore();
    } else {
      let entered!: () => void;
      const begun = new Promise<void>((r) => {
        entered = r;
      });
      const original = app.riff.repo.session.bind(app.riff.repo);
      const spy = vi.spyOn(app.riff.repo, 'session').mockImplementation((id) => {
        const result = original(id);
        entered();
        return result;
      });
      const activation = app.riff.runtime.activateTransition(transition.id);
      await begun;
      hide();
      await expect(activation).rejects.toThrow();
      spy.mockRestore();
    }
    expect(app.riff.repo.automation(f.automation.id)!.activeVersionId).toBe(f.base.id);
    expect(app.riff.repo.session(f.automation.id)).toEqual(before);
  },
  30000,
);
it('reconciles a queued interrupted selection visibly and never spends its durable claim again', async () => {
  let calls = 0;
  const offline = createOfflineTransport();
  const transport: CompilerTransport = {
    ...offline,
    async open(...args) {
      calls++;
      return offline.open(...args);
    },
  };
  const f = await setup(transport);
  const { selection } = await select(f.app);
  const runId = crypto.randomUUID();
  f.app.riff.repo.atomic(() => {
    f.app.riff.repo.insertRun({
      id: runId,
      automationId: null,
      baseVersionId: null,
      intent: 'Reviewed immutable brief',
      status: 'queued',
      transport: 'offline',
      model: null,
      promptVersion: 'pending',
      threadId: null,
      attempts: [],
      usage: null,
      durationMs: null,
      error: null,
      versionId: null,
    });
    f.app.riff.repo.linkSelectionRun(selection.id, runId);
  });
  await f.restart();
  const response = await post(f.app, `/api/proposals/selections/${selection.id}/generate`);
  expect(response.statusCode).toBe(202);
  expect(response.json()).toMatchObject({
    id: runId,
    stage: 'failed',
    result: { status: 'failed' },
  });
  expect(calls).toBe(0);
  expect(communityProjection(f.app.riff.proposals, f.app.riff.repo).selections[0]!.status).toBe(
    'failed',
  );
  const other = forChannel(f.database, 'other');
  other.ensure('other');
  expect(other.generationForSelection(selection.id)).toBeUndefined();
  expect(() => other.assertVersionLineage('missing')).toThrow('NOT_FOUND');
});
it('resumes the channel with removed active lineage paused, then permits an explicit clean rollback', async () => {
  const { app } = await setup(createOfflineTransport());
  const f = await battle(app);
  const transition = await f.preview();
  expect((await f.approve(transition)).statusCode).toBe(200);
  app.riff.studio.panic('recover safely');
  await post(app, `/api/proposals/${f.proposalId}/moderate`, {
    expectedRevision: f.selection.proposalRevision,
    action: 'hide',
  });
  expect((await post(app, '/api/channel/resume', { confirm: true })).statusCode).toBe(200);
  expect(app.riff.repo.automation(f.automation.id)!.status).toBe('paused');
  expect(app.riff.runtime.running()).toEqual([]);
  expect(app.riff.repo.session(f.automation.id)!.snapshot.phase).toBe('paused');
  const rollback = await post(app, `/api/automations/${f.automation.id}/rollback`, {
    resetSession: true,
  });
  expect(rollback.statusCode, rollback.body).toBe(200);
  expect(app.riff.repo.automation(f.automation.id)!.activeVersionId).toBe(f.base.id);
  expect(app.riff.runtime.running()[0]!.versionId).toBe(f.base.id);
}, 30000);
it('reselections invalidate earlier pending transitions and every selection in a descendant ancestry', async () => {
  const { app } = await setup(createOfflineTransport());
  const f = await battle(app);
  const pending = await f.preview('round-end');
  expect((await f.approve(pending)).statusCode).toBe(200);
  // An independently selected proposal can derive from the first selected candidate.
  const second = await select(
    app,
    f.next.id,
    'Keep !splat and add two additional throws for each player.',
  );
  const generated = await post(app, `/api/proposals/selections/${second.selection.id}/generate`);
  const run = await waitRun(app, generated.json().id);
  expect(run.status, run.error ?? '').toBe('ready');
  const descendant = app.riff.repo.version(run.versionId!)!;
  const replacement = await post(app, `/api/proposals/${f.proposalId}/select`, {
    expectedRevision: f.selection.proposalRevision,
    brief: 'Use !splat with two extra throws, deliberately reviewed again.',
    baseVersionId: f.base.id,
  });
  expect(replacement.statusCode, replacement.body).toBe(200);
  expect(app.riff.repo.transition(pending.id)!.status).toBe('cancelled');
  // The newest selection is still valid; the inherited older selection is stale.
  expect(() => app.riff.proposals.assertSelectionAuthorized(second.selection.id)).not.toThrow();
  expect(() => app.riff.repo.activate(f.automation.id, descendant.id)).toThrow('STALE');
}, 30000);
it('aborts hidden queued generation before the transport opens and replays its original claim', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const offline = createOfflineTransport();
  const transport: CompilerTransport = {
    ...offline,
    async open(request, files) {
      calls++;
      const session = await offline.open(request, files);
      return {
        ...session,
        async turn(prompt, options) {
          await gate;
          return session.turn(prompt, options);
        },
      };
    },
  };
  const { app } = await setup(transport);
  const first = await select(app, null, 'Type !tomato to toss a tomato on the screen.');
  const a = await post(app, `/api/proposals/selections/${first.selection.id}/generate`);
  await vi.waitFor(() => expect(calls).toBe(1));
  const second = await select(app, null, 'Type !heart to toss a heart on the screen.');
  const b = await post(app, `/api/proposals/selections/${second.selection.id}/generate`);
  expect(b.json().stage).toBe('queued');
  await post(app, `/api/proposals/${second.proposalId}/moderate`, {
    expectedRevision: second.selection.proposalRevision,
    action: 'hide',
  });
  release();
  await waitRun(app, a.json().id);
  await waitRun(app, b.json().id);
  expect(calls).toBe(1);
  expect(
    (await post(app, `/api/proposals/selections/${second.selection.id}/generate`)).json().id,
  ).toBe(b.json().id);
}, 30000);
it('returns the original successful run and candidate after restart without another compiler call', async () => {
  let calls = 0;
  const offline = createOfflineTransport();
  const transport: CompilerTransport = {
    ...offline,
    async open(...args) {
      calls++;
      return offline.open(...args);
    },
  };
  const f = await setup(transport);
  const { selection } = await select(f.app, null, 'Type !tomato to toss a tomato on the screen.');
  const generated = await post(f.app, `/api/proposals/selections/${selection.id}/generate`);
  const run = await waitRun(f.app, generated.json().id);
  expect(run.status, run.error ?? '').toBe('ready');
  const original = f.app.riff.repo.version(run.versionId!)!;
  const edited = f.app.riff.repo.insertVersion({
    ...original,
    parentVersionId: original.id,
    compileRunId: null,
  });
  f.app.riff.repo.activate(edited.automationId, edited.id);
  expect(communityProjection(f.app.riff.proposals, f.app.riff.repo).selections[0]!.status).toBe(
    'applied',
  );
  await f.restart();
  const replay = await post(f.app, `/api/proposals/selections/${selection.id}/generate`);
  expect(replay.statusCode, replay.body).toBe(202);
  expect(replay.json()).toMatchObject({
    id: run.id,
    stage: 'ready',
    result: { versionId: run.versionId, status: 'ready' },
  });
  expect(calls).toBe(1);
  expect(f.app.riff.repo.versions()).toHaveLength(2);
});

it('refuses a new F32 review when its proposal was hidden before rehearsal', async () => {
  const { app } = await setup(createOfflineTransport());
  const f = await battle(app);
  const before = app.riff.repo.session(f.automation.id);
  expect(
    (
      await post(app, `/api/proposals/${f.proposalId}/moderate`, {
        expectedRevision: f.selection.proposalRevision,
        action: 'hide',
      })
    ).statusCode,
  ).toBe(200);
  const response = await post(app, `/api/versions/${f.next.id}/transition/preview`, {
    boundary: 'round-end',
  });
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().code).toBe('REVOKED');
  expect(app.riff.repo.transitions(f.automation.id)).toEqual([]);
  expect(app.riff.repo.session(f.automation.id)).toEqual(before);
}, 30000);

it('rechecks proposal ancestry atomically after asynchronous F32 rehearsal before storing a review', async () => {
  const { app } = await setup(createOfflineTransport());
  const f = await battle(app);
  const before = app.riff.repo.session(f.automation.id);
  let entered!: () => void;
  const begun = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = app.riff.repo.session.bind(app.riff.repo);
  const read = vi.spyOn(app.riff.repo, 'session').mockImplementation((id) => {
    const row = original(id);
    entered();
    return row;
  });
  const request = post(app, `/api/versions/${f.next.id}/transition/preview`, {
    boundary: 'round-end',
  });
  await begun;
  read.mockRestore();
  expect(
    (
      await post(app, `/api/proposals/${f.proposalId}/moderate`, {
        expectedRevision: f.selection.proposalRevision,
        action: 'hide',
      })
    ).statusCode,
  ).toBe(200);
  const response = await request;
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().code).toBe('REVOKED');
  expect(app.riff.repo.transitions(f.automation.id)).toEqual([]);
  expect(app.riff.repo.session(f.automation.id)).toEqual(before);
}, 30000);

it.each(['before approval', 'inside pending transaction'] as const)(
  'refuses removed-ancestor F32 pending approval %s without relying on reconciliation',
  async (boundary) => {
    const { app } = await setup(createOfflineTransport());
    const f = await battle(app);
    // An ordinary descendant retains the selected candidate through its immutable parent.
    const target = app.riff.repo.insertVersion({
      ...f.next,
      parentVersionId: f.next.id,
      compileRunId: null,
    });
    const response = await post(app, `/api/versions/${target.id}/transition/preview`, {
      boundary: 'round-end',
    });
    expect(response.statusCode, response.body).toBe(200);
    const transition = response.json().transition;
    const before = app.riff.repo.session(f.automation.id);
    const hideWithoutReconciliation = () =>
      app.riff.proposals.moderate(
        { kind: 'creator' },
        {
          proposalId: f.proposalId,
          expectedRevision: f.selection.proposalRevision,
          action: 'hide',
        },
      );
    let atomic: ReturnType<typeof vi.spyOn> | undefined;
    if (boundary === 'before approval') hideWithoutReconciliation();
    else {
      const original = app.riff.repo.atomic.bind(app.riff.repo);
      atomic = vi.spyOn(app.riff.repo, 'atomic').mockImplementationOnce((work) => {
        hideWithoutReconciliation();
        return original(work);
      });
    }
    try {
      const approval = await post(app, `/api/transitions/${transition.id}/approve`, {
        evidenceId: transition.evidenceId,
        artifactId: target.artifactId,
        expectedActiveVersionId: f.base.id,
        sessionId: transition.sourceSessionId,
        boundary: 'round-end',
      });
      expect(approval.statusCode, approval.body).toBe(409);
      expect(approval.json().code).toBe('REVOKED');
      expect(app.riff.repo.transition(transition.id)!.status).toBe('review');
      expect(app.riff.repo.pendingTransitions()).toEqual([]);
      expect(app.riff.repo.session(f.automation.id)).toEqual(before);
      expect(app.riff.repo.automation(f.automation.id)!.activeVersionId).toBe(f.base.id);
    } finally {
      atomic?.mockRestore();
    }
  },
  30000,
);

it('coalesces console refreshes for vote bursts but publishes moderation at once', async () => {
  const f = await setup();
  const app = f.app;
  await chat(app, '!riff suggest Add two throws to every player', 'e1', 'author');
  const p = app.riff.proposals.snapshot().proposals[0]!;
  const shortlisted = app.riff.proposals.moderate(
    { kind: 'creator' },
    { proposalId: p.id, expectedRevision: p.revision, action: 'shortlist' },
  );
  const ballot = app.riff.proposals.createBallot(
    { kind: 'creator' },
    { proposalIds: [{ id: shortlisted.id, revision: shortlisted.revision }], durationSeconds: 60 },
  );
  let studio = 0;
  const unsubscribe = app.riff.hub.subscribe((message) => {
    if (message.type === 'studio') studio++;
  });
  for (let index = 0; index < 30; index++)
    await chat(app, `!riff vote ${ballot.number} 1`, `vote-${index}`, `voter-${index}`);
  expect(studio).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(studio).toBe(1);
  expect(app.riff.proposals.publicProjection().ballot?.options[0]?.votes).toBe(30);
  await chat(app, `!riff hide ${p.number}`, 'hide', 'owner', ['broadcaster']);
  expect(studio).toBe(2);
  unsubscribe();
});
