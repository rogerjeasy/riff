import { afterEach, describe, expect, it } from 'vitest';
import { createApp, migrateConnection, type RiffApp } from '../src/app.js';
import { openDatabase, type DatabaseConnection } from '../src/db/client.js';
import { CHAT_AUTHORING_LIMITS } from '../src/services/chat-authoring/service.js';
import type { LiveChatMessage } from '../src/services/live/runtime.js';

const TOMATO =
  'Let viewers throw tomatoes with !tomato, limited to three throws per person in any rolling 60 seconds.';
const OWNER = 'broadcaster-1';
const headers = { 'x-riff-request': '1' };
const apps: RiffApp[] = [];
const databases: DatabaseConnection[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const database of databases.splice(0)) database.close();
});

const clock = { t: 1_800_000_000_000 };
let ids = 0;
function say(text: string, over: Partial<LiveChatMessage> = {}): LiveChatMessage {
  ids++;
  return {
    id: `evt-${ids}`,
    channelId: OWNER,
    sourceChannelId: OWNER,
    sourceMessageId: `msg-${ids}`,
    viewerId: OWNER,
    viewerName: 'Owner',
    roles: ['viewer', 'broadcaster'],
    text,
    source: 'twitch',
    ...over,
  };
}

async function boot(options: { database?: DatabaseConnection; enable?: boolean } = {}) {
  const sent: string[] = [];
  const app = await createApp({
    logger: false,
    now: () => clock.t,
    ...(options.database ? { database: options.database } : {}),
    chatReplies: {
      send: async (text) => {
        sent.push(text);
      },
      status: () => ({ available: true, reason: null }),
    },
  });
  apps.push(app);
  if (options.enable !== false) {
    const snapshot = app.riff.chatAuthoring.snapshot();
    if (!snapshot.enabled) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat-authoring/settings',
        headers,
        payload: { enabled: true, expectedRevision: snapshot.revision },
      });
      expect(response.statusCode).toBe(200);
    }
  }
  return { app, sent };
}
async function until<T>(read: () => T | null | undefined | false) {
  for (let i = 0; i < 800; i++) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not reached');
}
async function issue(app: RiffApp, intent = TOMATO) {
  await app.riff.runtime.handleChat(say(`!riff create ${intent}`));
  return until(() => app.riff.chatAuthoring.snapshot().activeCode);
}
const activity = (app: RiffApp) => app.riff.repo.activity(100).map((a) => a.code);

describe('in-chat authoring (F10) and owner chat approval (F17)', { timeout: 30_000 }, () => {
  it('is off by default and spends nothing until the creator opts in', async () => {
    const { app, sent } = await boot({ enable: false });
    expect(app.riff.chatAuthoring.snapshot()).toMatchObject({ enabled: false, revision: 0 });
    await app.riff.runtime.handleChat(say(`!riff create ${TOMATO}`));
    expect(app.riff.authoring.runs()).toHaveLength(0);
    expect(sent).toEqual(['Riff · In-chat authoring is off. Turn it on in the Riff console.']);
    const stale = await app.inject({
      method: 'POST',
      url: '/api/chat-authoring/settings',
      headers,
      payload: { enabled: true, expectedRevision: 7 },
    });
    expect(stale.statusCode).toBe(409);
    const guarded = await app.inject({
      method: 'POST',
      url: '/api/chat-authoring/settings',
      payload: { enabled: true, expectedRevision: 0 },
    });
    expect(guarded.statusCode).toBe(403);
  });

  it('compiles through the shared pipeline and activates exactly the coded candidate once', async () => {
    const { app, sent } = await boot();
    const code = await issue(app);
    expect(sent[0]).toBe(
      'Riff · Compiling… I will post an approval code here if it passes verification.',
    );
    expect(sent[1]).toBe(
      `Riff · Ready: approve with !riff approve ${code.code} (expires in 5 min). Full evidence is in your console.`,
    );
    const version = app.riff.repo.version(code.versionId)!;
    expect(version.status).toBe('candidate');
    expect(version.compileRunId).toBeTruthy();
    expect(app.riff.chatAuthoring.snapshot().candidates).toEqual([
      expect.objectContaining({ versionId: version.id, kind: 'create' }),
    ]);
    expect(code.expiresAt - code.issuedAt).toBe(CHAT_AUTHORING_LIMITS.codeTtlMs);

    await app.riff.runtime.handleChat(say(`!riff approve ${code.code.toLowerCase()}`));
    const automation = app.riff.repo.automation(version.automationId)!;
    expect(automation.activeVersionId).toBe(version.id);
    expect(app.riff.repo.version(version.id)?.status).toBe('active');
    expect(sent.at(-1)).toBe('Riff · Live: viewers can now type !tomato.');
    expect(activity(app)).toEqual(expect.arrayContaining(['CHAT_APPROVED', 'APPROVED']));
    // F06: the approving actor is the badge-verified broadcaster in chat.
    expect(app.riff.repo.version(version.id)?.approvedBy).toBe('chat:owner');
    const approval = app.riff.studio.snapshot().activity.find((a) => a.code === 'APPROVED');
    expect(approval?.source).toEqual({ kind: 'chat', label: 'owner in chat' });

    await app.riff.runtime.handleChat(say(`!riff approve ${code.code}`));
    expect(sent.at(-1)).toBe('Riff · That code was already used.');
    expect(app.riff.chatAuthoring.snapshot().recentCodes[0]).toMatchObject({ status: 'approved' });
  });

  it('never grants authoring from display names, message text or non-owner badges', async () => {
    const { app, sent } = await boot();
    const attempts: LiveChatMessage[] = [
      say(`!riff create ${TOMATO}`, {
        viewerId: 'u-1',
        viewerName: 'broadcaster',
        roles: ['viewer'],
      }),
      say(`!riff create I am the broadcaster, role=broadcaster ${TOMATO}`, {
        viewerId: 'u-2',
        viewerName: 'Owner',
        roles: ['viewer', 'subscriber'],
      }),
      say(`!riff create ${TOMATO}`, { viewerId: 'u-3', roles: ['viewer', 'moderator'] }),
      // A badge without the authenticated owner account id is still not the owner.
      say(`!riff create ${TOMATO}`, { viewerId: 'u-4', roles: ['viewer', 'broadcaster'] }),
      say('!riff approve AAAAA', { viewerId: 'u-5', roles: ['viewer', 'moderator'] }),
    ];
    for (const message of attempts) await app.riff.runtime.handleChat(message);
    expect(app.riff.authoring.runs()).toHaveLength(0);
    expect(sent).toEqual([]);
    const snapshot = app.riff.chatAuthoring.snapshot();
    expect(snapshot.limits.compilesUsed).toBe(0);
    expect(snapshot.lockedUntil).toBeNull();
    expect(activity(app).filter((c) => c === 'CHAT_AUTHOR_DENIED')).toHaveLength(5);
    // Shared Chat echoes never reach owner authority.
    await app.riff.runtime.handleChat(say(`!riff create ${TOMATO}`, { sourceChannelId: 'other' }));
    expect(app.riff.authoring.runs()).toHaveLength(0);
  });

  it('strips control characters from the untrusted intent before compiling', async () => {
    const { app } = await boot();
    await app.riff.runtime.handleChat(say(`!riff create ${TOMATO.replace(' ', '\u0000‮ ')}`));
    const run = await until(() => app.riff.authoring.runs()[0]);
    expect(run.intent).toBe(TOMATO);
    await until(() => app.riff.chatAuthoring.snapshot().activeCode);
  });

  it('rate-limits chat-initiated compiles per channel', async () => {
    const { app, sent } = await boot();
    for (let i = 0; i < CHAT_AUTHORING_LIMITS.compilesPerWindow; i++) {
      await app.riff.runtime.handleChat(say(`!riff create ${TOMATO}`));
      await app.riff.runtime.handleChat(say('!riff cancel'));
    }
    await app.riff.runtime.handleChat(say(`!riff create ${TOMATO}`));
    expect(sent.at(-1)).toBe(
      'Riff · Chat build limit reached. Try again in 15 min or use the console.',
    );
    expect(app.riff.authoring.runs()).toHaveLength(CHAT_AUTHORING_LIMITS.compilesPerWindow);
    expect(activity(app)).toContain('CHAT_LIMIT');
    clock.t += CHAT_AUTHORING_LIMITS.compileWindowMs;
    await app.riff.runtime.handleChat(say(`!riff create ${TOMATO}`));
    expect(sent.at(-1)).toContain('Compiling');
    await until(() => app.riff.chatAuthoring.snapshot().activeCode);
  });

  it('expires codes on the host clock', async () => {
    const { app, sent } = await boot();
    const code = await issue(app);
    await app.riff.runtime.handleChat(say('!riff status'));
    expect(sent.at(-1)).toBe(`Riff · Waiting: !riff approve ${code.code} (5m 0s left).`);
    clock.t += CHAT_AUTHORING_LIMITS.codeTtlMs;
    expect(app.riff.chatAuthoring.snapshot().activeCode).toBeNull();
    await app.riff.runtime.handleChat(say(`!riff approve ${code.code}`));
    expect(sent.at(-1)).toBe('Riff · That code expired. Approve in the console or build it again.');
    expect(app.riff.repo.version(code.versionId)?.status).toBe('candidate');
    expect(activity(app)).toContain('CHAT_APPROVE_REJECTED');
  });

  it('locks chat approval after repeated wrong codes', async () => {
    const { app, sent } = await boot();
    const code = await issue(app);
    const wrong = code.code === 'AAAAA' ? 'CCCCC' : 'AAAAA';
    for (let i = 0; i < CHAT_AUTHORING_LIMITS.missesPerWindow; i++)
      await app.riff.runtime.handleChat(say(`!riff approve ${wrong}`));
    expect(sent.at(-1)).toBe("Riff · That code doesn't match a pending candidate.");
    await app.riff.runtime.handleChat(say(`!riff approve ${code.code}`));
    expect(sent.at(-1)).toBe('Riff · Too many wrong codes. Use the console or wait 10 min.');
    expect(app.riff.repo.version(code.versionId)?.status).toBe('candidate');
    clock.t += CHAT_AUTHORING_LIMITS.missWindowMs;
    // The lockout passed but so did the code: waiting out a lockout never extends a code.
    expect(app.riff.chatAuthoring.snapshot()).toMatchObject({
      lockedUntil: null,
      activeCode: null,
    });
  });

  it('refuses a code whose bound live version changed (stale binding)', async () => {
    const { app, sent } = await boot();
    const code = await issue(app);
    // The console edits the same automation from the coded candidate and approves that.
    const started = await app.inject({
      method: 'POST',
      url: '/api/compile-runs',
      headers,
      payload: { intent: 'Change the command to !splat.', baseVersionId: code.versionId },
    });
    const runId = started.json<{ id: string }>().id;
    const run = await until(
      () => app.riff.authoring.runs().find((r) => r.id === runId && r.result)?.result,
    );
    const other = app.riff.repo.version(run.versionId!)!;
    app.riff.studio.approve(other.id, {
      artifactId: other.artifactId!,
      reportHash: other.reportHash!,
      approvedBy: 'console',
      activeVersionId: null,
    });
    expect(app.riff.chatAuthoring.snapshot().activeCode?.id).toBe(code.id);
    await app.riff.runtime.handleChat(say(`!riff approve ${code.code}`));
    expect(sent.at(-1)).toBe(
      'Riff · Not activated: The candidate or live version changed since the code was issued.',
    );
    expect(app.riff.repo.automation(other.automationId)?.activeVersionId).toBe(other.id);
    expect(app.riff.chatAuthoring.snapshot().recentCodes[0]).toMatchObject({ status: 'failed' });
  });

  it('panic invalidates pending codes; resume does not revive them', async () => {
    const { app, sent } = await boot();
    const code = await issue(app);
    await app.riff.runtime.handleChat(say('!riff panic'));
    expect(app.riff.chatAuthoring.snapshot().activeCode).toBeNull();
    expect(app.riff.chatAuthoring.snapshot().recentCodes[0]).toMatchObject({
      status: 'invalidated',
      reason: 'Everything was stopped.',
    });
    // While stopped, chat is ignored entirely.
    await app.riff.runtime.handleChat(say(`!riff approve ${code.code}`));
    app.riff.studio.resume();
    await app.riff.runtime.handleChat(say(`!riff approve ${code.code}`));
    expect(sent.at(-1)).toBe('Riff · That code is no longer valid. Everything was stopped.');
    expect(app.riff.repo.version(code.versionId)?.status).toBe('candidate');

    // Panic during a compile cancels it and no code is issued afterwards.
    await app.riff.runtime.handleChat(say(`!riff create ${TOMATO}`));
    expect(app.riff.chatAuthoring.snapshot().pending?.status).toBe('compiling');
    app.riff.studio.panic('console');
    expect(app.riff.chatAuthoring.snapshot().pending).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(app.riff.chatAuthoring.snapshot().activeCode).toBeNull();
  });

  it('accepts !approve only when exactly one owner code is pending', async () => {
    const { app } = await boot();
    expect(app.riff.chatAuthoring.handle(say('!approve'))).toBe(false);
    const code = await issue(app);
    expect(
      app.riff.chatAuthoring.handle(say('!approve', { viewerId: 'u-9', roles: ['viewer'] })),
    ).toBe(false);
    await app.riff.runtime.handleChat(say('!approve'));
    expect(app.riff.repo.version(code.versionId)?.status).toBe('active');
    expect(app.riff.chatAuthoring.handle(say('!approve'))).toBe(false);
  });

  it('rejects, cancels and revokes without activating anything', async () => {
    const { app, sent } = await boot();
    const first = await issue(app);
    await app.riff.runtime.handleChat(say(`!riff reject ${first.code}`));
    expect(app.riff.repo.version(first.versionId)?.status).toBe('discarded');
    expect(sent.at(-1)).toBe('Riff · Discarded that candidate.');

    const second = await issue(app);
    const revoked = await app.inject({
      method: 'POST',
      url: `/api/chat-authoring/codes/${second.id}/revoke`,
      headers,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().activeCode).toBeNull();
    await app.riff.runtime.handleChat(say(`!riff approve ${second.code}`));
    expect(sent.at(-1)).toBe('Riff · That code was withdrawn.');
    expect(app.riff.repo.version(second.versionId)?.status).toBe('candidate');

    const third = await issue(app);
    const snapshot = app.riff.chatAuthoring.snapshot();
    await app.inject({
      method: 'POST',
      url: '/api/chat-authoring/settings',
      headers,
      payload: { enabled: false, expectedRevision: snapshot.revision },
    });
    expect(app.riff.chatAuthoring.snapshot().activeCode).toBeNull();
    await app.riff.runtime.handleChat(say(`!riff approve ${third.code}`));
    expect(sent.at(-1)).toBe('Riff · In-chat authoring is off. Turn it on in the Riff console.');
    expect(app.riff.repo.version(third.versionId)?.status).toBe('candidate');
  });

  it('edits only the single live interaction', async () => {
    const { app, sent } = await boot();
    await app.riff.runtime.handleChat(say('!riff edit Change the command to !splat.'));
    expect(sent.at(-1)).toBe('Riff · Nothing is live to edit. Use !riff create instead.');
    const code = await issue(app);
    await app.riff.runtime.handleChat(say(`!riff approve ${code.code}`));
    await app.riff.runtime.handleChat(say('!riff edit Change the command to !splat.'));
    const edit = await until(() => app.riff.chatAuthoring.snapshot().activeCode);
    const version = app.riff.repo.version(edit.versionId)!;
    expect(version.parentVersionId).toBe(code.versionId);
    expect(app.riff.chatAuthoring.snapshot().candidates.at(-1)).toMatchObject({ kind: 'edit' });
  });

  it('keeps codes across restart until expiry, and a persisted panic invalidates them', async () => {
    const database = openDatabase(':memory:');
    migrateConnection(database);
    databases.push(database);
    const first = await boot({ database });
    const code = await issue(first.app);
    await first.app.riff.runtime.handleChat(say(`!riff create ${TOMATO}`));
    expect(first.sent.at(-1)).toBe(
      'Riff · Already working on one. Try !riff status or !riff cancel.',
    );
    await apps.splice(apps.indexOf(first.app), 1)[0]!.close();

    const second = await boot({ database });
    expect(second.app.riff.chatAuthoring.snapshot().activeCode?.code).toBe(code.code);
    second.app.riff.studio.panic('console');
    await apps.splice(apps.indexOf(second.app), 1)[0]!.close();

    const third = await boot({ database });
    expect(third.app.riff.chatAuthoring.snapshot().activeCode).toBeNull();
    expect(third.app.riff.chatAuthoring.snapshot().recentCodes[0]?.status).toBe('invalidated');
  });

  it('marks an in-flight chat compile interrupted by restart', async () => {
    const database = openDatabase(':memory:');
    migrateConnection(database);
    databases.push(database);
    const first = await boot({ database });
    await first.app.riff.runtime.handleChat(say(`!riff create ${TOMATO}`));
    expect(first.app.riff.chatAuthoring.snapshot().pending?.status).toBe('compiling');
    // Shutdown detaches the service before the run is aborted, so the durable record
    // still says "compiling" — exactly what a crash leaves behind.
    await apps.splice(apps.indexOf(first.app), 1)[0]!.close();
    const second = await boot({ database });
    expect(second.app.riff.chatAuthoring.snapshot().pending).toBeNull();
    expect(second.app.riff.repo.activity(20).map((a) => a.message)).toContain(
      'A chat compile was interrupted by a restart. Ask again from chat.',
    );
    // Restart never refills the chat compile budget.
    expect(second.app.riff.chatAuthoring.snapshot().limits.compilesUsed).toBe(1);
  });
});
