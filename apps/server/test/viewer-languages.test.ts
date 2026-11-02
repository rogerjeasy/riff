import { afterEach, describe, expect, it } from 'vitest';
import { compileOffline } from '@riff/compiler';
import { verifyCandidate } from '@riff/sandbox';
import { createApp, migrateConnection, type RiffApp } from '../src/app.js';
import { openDatabase, type DatabaseConnection } from '../src/db/client.js';
import { forChannel } from '../src/db/repositories/studio.js';
import { viewerPreferences } from '../src/db/schema.js';
import { createParticipationService } from '../src/services/participation/service.js';
import {
  createViewerLanguageStore,
  parseLanguageCommand,
  VIEWER_LANGUAGE,
} from '../src/services/participation/preferences.js';
import type { LiveChatMessage } from '../src/services/live/runtime.js';

const headers = { 'x-riff-request': '1' };
const apps: RiffApp[] = [];
const databases: DatabaseConnection[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  for (const db of databases.splice(0)) db.close();
});

let ids = 0;
function chat(
  channelId: string,
  viewerId: string,
  text: string,
  over: Partial<LiveChatMessage> = {},
): LiveChatMessage {
  ids += 1;
  return {
    id: `m-${ids}`,
    channelId,
    viewerId,
    viewerName: 'Viewer',
    roles: ['viewer'] as LiveChatMessage['roles'],
    text,
    source: 'twitch',
    ...over,
  };
}

async function boot(options: { replies?: boolean; database?: DatabaseConnection } = {}) {
  const clock = { t: 1_000_000 };
  const sent: { text: string; replyTo: string | undefined }[] = [];
  const app = await createApp({
    logger: false,
    now: () => clock.t,
    ...(options.database ? { database: options.database } : {}),
    chatReplies: {
      send: async (text, replyTo) => {
        sent.push({ text, replyTo });
      },
      status: () => ({ available: true, reason: null }),
    },
  });
  apps.push(app);
  if (options.replies) {
    const snapshot = app.riff.chatAuthoring.snapshot();
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat-authoring/settings',
      headers,
      payload: { enabled: true, expectedRevision: snapshot.revision },
    });
    expect(response.statusCode).toBe(200);
  }
  return { app, sent, clock, channel: app.riff.repo.channelId };
}

async function live(app: RiffApp) {
  const out = compileOffline({
    intent: 'Let viewers throw tomatoes with !tomato, three times per person per 60 seconds.',
    base: null,
  });
  const verification = await verifyCandidate({
    source: out.source!,
    manifest: out.manifest,
    tests: out.tests,
  });
  const v = app.riff.repo.insertVersion({
    automationId: app.riff.repo.createAutomation('Tomato Toss').id,
    parentVersionId: null,
    artifactId: verification.artifactId,
    title: 'Tomato Toss',
    intent: 'PRIVATE INTENT',
    source: out.source!,
    manifest: out.manifest,
    tests: out.tests,
    behavior: out.behavior,
    assumptions: [],
    evidence: { verification, intent: [] },
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
  app.riff.studio.approve(v.id, {
    artifactId: v.artifactId!,
    reportHash: v.reportHash!,
    approvedBy: 'console',
    activeVersionId: null,
  });
  return v;
}

describe('F20 viewer language preferences', () => {
  it('parses !riff language and !riff lang, rejecting unsupported languages without echoing', () => {
    expect(parseLanguageCommand('!riff language fr')).toEqual({ choice: 'fr' });
    expect(parseLanguageCommand('!RIFF LANG DE')).toEqual({ choice: 'de' });
    expect(parseLanguageCommand('!riff language off')).toEqual({ choice: 'off' });
    expect(parseLanguageCommand('!riff language klingon')).toEqual({ choice: undefined });
    expect(parseLanguageCommand('!riff language')).toEqual({ choice: undefined });
    expect(parseLanguageCommand('!riff help fr')).toBeNull();
  });

  it('accepts real Twitch chat, whose channel id is the broadcaster user id (production regression)', async () => {
    const { app, sent } = await boot({ replies: true });
    await live(app);
    app.riff.repo.updateState({ twitchUserId: '700001' });
    // EventSub delivers channel.chat.message with the broadcaster's Twitch user id, not 'home'.
    await app.riff.runtime.handleChat(
      chat('700001', '700001', '!riff language fr', {
        roles: ['broadcaster', 'viewer'] as LiveChatMessage['roles'],
        sourceMessageId: 'twitch-msg-1',
      }),
    );
    expect(app.riff.participation.viewerLanguage('700001')).toBe('fr');
    await app.riff.runtime.handleChat(chat('700001', 'u-viewer', '!riff help'));
    expect(sent.length).toBeGreaterThanOrEqual(1);
    // Another channel's id is still refused.
    await app.riff.runtime.handleChat(chat('999999', 'u-2', '!riff language de'));
    expect(app.riff.participation.viewerLanguage('u-2')).toBe('en');
  });

  it('sets, clears and persists a choice keyed by EventSub user id across restart', async () => {
    const database = openDatabase(':memory:');
    databases.push(database);
    migrateConnection(database);
    const first = await boot({ database });
    await first.app.riff.runtime.handleChat(chat(first.channel, 'u-1', '!riff language fr'));
    expect(first.app.riff.participation.viewerLanguage('u-1')).toBe('fr');
    // Only a pseudonymous key is stored, never the user id or display name.
    const rows = database.db.select().from(viewerPreferences).all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('u-1');
    expect(JSON.stringify(rows)).not.toContain('Viewer');
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);

    const second = await boot({ database });
    expect(second.app.riff.participation.viewerLanguage('u-1')).toBe('fr');
    second.clock.t += VIEWER_LANGUAGE.perViewerMs;
    await second.app.riff.runtime.handleChat(chat(second.channel, 'u-1', '!riff lang off'));
    expect(second.app.riff.participation.viewerLanguage('u-1')).toBe('en');
    expect(database.db.select().from(viewerPreferences).all()).toHaveLength(0);
  });

  it('ignores display names and role badges: only the user id selects the preference', async () => {
    const { app, channel } = await boot();
    await app.riff.runtime.handleChat(
      chat(channel, 'u-mod', '!riff language de', {
        viewerName: 'TheBroadcaster',
        roles: ['viewer', 'moderator', 'broadcaster'],
      }),
    );
    // Same display name and badges, different user id: no shared or elevated preference.
    expect(app.riff.participation.viewerLanguage('u-other')).toBe('en');
    expect(app.riff.participation.viewerLanguage(channel)).toBe('en');
    expect(app.riff.participation.viewerLanguage('u-mod')).toBe('de');
  });

  it('falls back from the viewer choice to the channel language, then English', async () => {
    const { app, channel } = await boot();
    const p = app.riff.participation;
    expect(p.viewerLanguage('u-1')).toBe('en');
    p.save(0, { language: 'es', reducedMotion: false, highContrast: false, effectLabels: false });
    expect(p.viewerLanguage('u-1')).toBe('es');
    await app.riff.runtime.handleChat(chat(channel, 'u-1', '!riff language fr'));
    expect(p.viewerLanguage('u-1')).toBe('fr');
    // A disallowed choice is deleted and the channel language applies again.
    p.setViewerLanguages(false);
    expect(p.viewerLanguage('u-1')).toBe('es');
    p.setViewerLanguages(true);
    expect(p.viewerLanguage('u-1')).toBe('es');
  });

  it('answers help in the viewer language while the shared panel stays in the channel language', async () => {
    const { app, sent, channel, clock } = await boot({ replies: true });
    const v = await live(app);
    const p = app.riff.participation;
    p.save(0, { language: 'en', reducedMotion: false, highContrast: false, effectLabels: false });
    await app.riff.runtime.handleChat(chat(channel, 'u-fr', '!riff language fr'));
    expect(sent.at(-1)?.text).toContain('français');
    clock.t += 1000;
    const help = chat(channel, 'u-fr', '!riff help');
    await app.riff.runtime.handleChat(help);
    const reply = sent.at(-1)!;
    expect(reply.replyTo).toBe(help.id);
    expect(reply.text).toMatch(/^Riff · Tomato Toss: Tout le monde/);
    expect(p.presentation(v.id, null)?.language).toBe('en');
    expect(p.presentation(v.id, null)?.instructions.join(' ')).toContain('Everyone');
    // Another viewer without a choice gets the channel language.
    await app.riff.runtime.handleChat(chat(channel, 'u-en', '!riff help'));
    expect(sent.at(-1)?.text).toContain('Everyone');
  });

  it('answers unknown languages with the supported list and never echoes the argument', async () => {
    const { app, sent, channel } = await boot({ replies: true });
    const result = app.riff.participation.language(chat(channel, 'u-1', '!riff language <script>'));
    expect(result).toEqual({ consumed: true, accepted: false });
    expect(sent.at(-1)?.text).toBe(
      'Riff · Choose a language: !riff language en, fr, es, de or off.',
    );
    expect(sent.map((s) => s.text).join(' ')).not.toContain('script');
  });

  it('without a chat reply path confirms on stream through the help highlight', async () => {
    const { app, sent, channel } = await boot();
    const v = await live(app);
    const p = app.riff.participation;
    expect(p.language(chat(channel, 'u-1', '!riff language de')).accepted).toBe(true);
    expect(sent).toHaveLength(0);
    expect(p.presentation(v.id, null)).toMatchObject({ language: 'de', help: true });
  });

  it('rate limits per viewer and per channel', async () => {
    const { app, channel, clock } = await boot();
    const p = app.riff.participation;
    expect(p.language(chat(channel, 'u-1', '!riff language fr')).accepted).toBe(true);
    expect(p.language(chat(channel, 'u-1', '!riff language es')).accepted).toBe(false);
    expect(p.viewerLanguage('u-1')).toBe('fr');
    clock.t += VIEWER_LANGUAGE.perViewerMs;
    expect(p.language(chat(channel, 'u-1', '!riff language es')).accepted).toBe(true);
    for (let i = 2; i < VIEWER_LANGUAGE.perChannelPerMinute; i++)
      expect(p.language(chat(channel, `u-${i + 10}`, '!riff language de')).accepted).toBe(true);
    expect(p.language(chat(channel, 'u-late', '!riff language de')).accepted).toBe(false);
    expect(p.viewerLanguage('u-late')).toBe('en');
    clock.t += 60_000;
    expect(p.language(chat(channel, 'u-late', '!riff language de')).accepted).toBe(true);
  });

  it('exposes only suppressed aggregate counts and a creator toggle, never per-viewer data', async () => {
    const { app, channel, clock } = await boot();
    const p = app.riff.participation;
    for (const [i, lang] of ['fr', 'fr', 'fr', 'de'].entries())
      p.language(chat(channel, `secret-viewer-${i}`, `!riff language ${lang}`));
    clock.t += 1;
    const body = (await app.inject('/api/participation')).json();
    expect(body.viewerLanguages).toEqual({
      enabled: true,
      total: 4,
      languages: [
        { language: 'en', count: 0 },
        { language: 'fr', count: 3 },
        { language: 'es', count: 0 },
        { language: 'de', count: null },
      ],
    });
    const raw = JSON.stringify(body) + JSON.stringify((await app.inject('/participation')).json());
    expect(raw).not.toContain('secret-viewer');
    const off = await app.inject({
      method: 'POST',
      url: '/api/participation/viewer-languages',
      headers,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().viewerLanguages).toMatchObject({ enabled: false, total: 0 });
    expect(p.language(chat(channel, 'u-new', '!riff language fr')).accepted).toBe(false);
    expect(p.viewerLanguage('u-new')).toBe('en');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/participation/viewer-languages',
          headers,
          payload: { enabled: 'yes' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('purges idle choices, bounds the table and keeps channels separate', () => {
    const db = openDatabase(':memory:');
    databases.push(db);
    migrateConnection(db);
    const a = forChannel(db, 'a'),
      b = forChannel(db, 'b');
    a.ensure('A');
    b.ensure('B');
    let at = 1_000_000;
    const make = (repo: typeof a) =>
      createParticipationService({
        database: db,
        repo,
        blocked: () => false,
        changed: () => {},
        now: () => at,
      });
    const sa = make(a),
      sb = make(b);
    sa.language(chat('a', 'u-1', '!riff language fr'));
    expect(sb.viewerLanguage('u-1')).toBe('en');
    expect(sb.language(chat('a', 'u-2', '!riff language fr')).accepted).toBe(false);
    at += VIEWER_LANGUAGE.retentionMs + 1;
    expect(sa.viewerLanguage('u-1')).toBe('en');
    expect(sa.viewerLanguages().total).toBe(0);
    sa.close();
    sb.close();
    const store = createViewerLanguageStore({ database: db, channelId: 'a', now: () => at });
    for (let i = 0; i <= VIEWER_LANGUAGE.maxRows; i++) {
      at += 1;
      store.set(`bulk-${i}`, 'de');
    }
    expect(store.counts().total).toBe(VIEWER_LANGUAGE.maxRows);
    expect(store.get('bulk-0')).toBeNull();
    expect(store.get(`bulk-${VIEWER_LANGUAGE.maxRows}`)).toBe('de');
  });
});
