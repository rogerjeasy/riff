import { afterEach, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { compileOffline } from '@riff/compiler';
import { openDatabase } from '../src/db/client.js';
import { forChannel } from '../src/db/repositories/studio.js';
import { createProductionService } from '../src/services/production/service.js';
import { readNativeImport } from '../src/services/production/native/index.js';
import { createApp, type RiffApp } from '../src/app.js';

const dispose: (() => void)[] = [];
const apps: RiffApp[] = [];
afterEach(async () => {
  dispose.splice(0).forEach((close) => close());
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

function setup() {
  const db = openDatabase(':memory:');
  migrate(db.db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const repo = forChannel(db, 'test');
  repo.ensure('Test');
  const service = createProductionService({
    database: db,
    repo,
    secret: 'test-sealing-key-for-production-only',
    overlayUrl: () => 'https://riff.example/overlay/?key=private-overlay-key',
    blocked: () => false,
    control: vi.fn(),
    now: () => 100000,
  });
  dispose.push(() => {
    service.close();
    db.close();
  });
  const out = compileOffline({
    intent: 'Let viewers throw tomatoes with !tomato, three times per person per 60 seconds.',
    base: null,
  });
  const version = repo.insertVersion({
    automationId: repo.createAutomation('Test').id,
    parentVersionId: null,
    artifactId: 'a'.repeat(64),
    title: 'Tomato toss',
    intent: 'private',
    source: out.source!,
    manifest: out.manifest,
    tests: out.tests,
    behavior: out.behavior,
    assumptions: [],
    evidence: {},
    origin: 'manual',
    compileRunId: null,
    status: 'candidate',
  });
  repo.activate(version.automationId, version.id, 'console');
  return { db, service, version };
}

/** Synthetic Firebot setup following src/types/setups.ts (FirebotSetup). */
const firebotSetup = {
  name: 'Tomato pack',
  description: 'Synthetic',
  author: 'tester',
  version: 1,
  importQuestions: [],
  requireCurrency: false,
  components: {
    commands: [
      {
        id: 'cmd-tomato',
        trigger: '!tomato',
        active: true,
        effects: {
          id: 'list-1',
          list: [
            { id: 'e1', type: 'firebot:chat', message: 'Splat!', chatter: 'Bot' },
            { id: 'e2', type: 'ebiggz:obs-change-scene', sceneName: 'Splat cam' },
            {
              id: 'e3',
              type: 'firebot:customscript',
              scriptName: 'steal.js',
              parameters: { danger: 'process.exit()' },
            },
          ],
        },
      },
      { id: 'cmd-off', trigger: '!off', active: false, effects: { id: 'l', list: [] } },
    ],
    events: [
      {
        id: 'ev-cheer',
        name: 'Cheer alert',
        sourceId: 'twitch',
        eventId: 'cheer',
        active: true,
        effects: {
          id: 'l2',
          list: [
            { id: 'e4', type: 'firebot:playsound', filepath: 'C:\\sounds\\cheer.mp3' },
            {
              id: 'e5',
              type: 'ebiggz:obs-toggle-source-visibility',
              selectedSources: [{ sceneName: 'Main', sourceId: 3, action: true }],
            },
          ],
        },
      },
      {
        id: 'ev-raid',
        name: 'Raid',
        sourceId: 'twitch',
        eventId: 'raid',
        active: false,
        effects: { id: 'l3', list: [] },
      },
    ],
    eventGroups: [],
    presetEffectLists: [
      {
        id: 'preset-1',
        name: 'Confetti',
        args: [],
        effects: { id: 'l4', list: [{ id: 'e6', type: 'firebot:run-program', program: 'x' }] },
      },
    ],
    timers: [{ id: 't1', name: 'Hydrate' }],
    counters: [],
  },
};

/** Synthetic Streamer.bot export payload (best-effort shape; see native/streamer-bot.ts). */
const streamerbotExport = {
  meta: { name: 'Tomato', author: 'tester', version: '1.0.0', minimumVersion: '0.2.5' },
  data: {
    actions: [
      {
        id: 'sb-1',
        name: 'Tomato hit',
        enabled: true,
        group: 'Games',
        triggers: [
          { $type: 'Streamer.bot.Triggers.CommandTriggered', id: 't1', commandId: 'c1' },
          { $type: 'Streamer.bot.Triggers.TwitchCheer', id: 't2' },
        ],
        subActions: [
          { $type: 'Streamer.bot.SubActions.ObsSetScene', sceneName: 'Splat cam' },
          {
            $type: 'Streamer.bot.SubActions.ObsSetSourceVisibility',
            sceneName: 'Main',
            sourceName: 'Tomato',
            state: 1,
          },
          { $type: 'Streamer.bot.SubActions.TwitchSendMessage', text: 'Splat!' },
          {
            $type: 'Streamer.bot.SubActions.ExecuteCode',
            byteCode: 'AAAA',
            code: 'Environment.Exit(1);',
          },
        ],
      },
      { id: 'sb-2', name: 'Old', enabled: false, triggers: [], subActions: [] },
      {
        id: 'sb-3',
        name: 'Raid shoutout',
        enabled: true,
        triggers: [{ $type: 'Streamer.bot.Triggers.TwitchRaid' }],
        subActions: [{ $type: 'Streamer.bot.SubActions.PlaySound', soundFile: '/x/horn.wav' }],
      },
    ],
    commands: [{ id: 'c1', name: 'Tomato', command: '!tomato\n!splat', enabled: true }],
  },
};

const obsCollection = {
  name: 'Streaming',
  current_scene: 'Main',
  current_program_scene: 'Main',
  scene_order: [{ name: 'Main' }, { name: 'BRB' }],
  sources: [
    {
      id: 'scene',
      versioned_id: 'scene',
      name: 'Main',
      uuid: 'u1',
      settings: {
        items: [
          { name: 'Riff', visible: true },
          { name: 'Camera', visible: true },
        ],
      },
    },
    { id: 'scene', name: 'BRB', settings: { items: [] } },
    {
      id: 'browser_source',
      name: 'Riff',
      settings: { url: 'https://riff.example/overlay/?key=secret-overlay-key', width: 1920 },
    },
    { id: 'ffmpeg_source', name: 'Horn', settings: { local_file: '/Users/me/horn.mp4' } },
    { id: 'dshow_input', name: 'Camera', settings: {} },
    { id: 'some_plugin_source', name: 'Plugin thing', settings: {} },
  ],
  groups: [],
  modules: {
    'scripts-tool': [{ path: '/Users/me/scripts/auto.lua', settings: {} }],
    'auto-scene-switcher': { active: false },
  },
};

it('reads a Firebot setup as data, maps triggers and lists scripts for manual review', () => {
  const report = readNativeImport('firebot', JSON.stringify(firebotSetup));
  expect(report.title).toBe('Tomato pack');
  const byName = (name: string) => report.items.find((i) => i.name === name)!;
  const tomato = byName('!tomato');
  expect(tomato.status).toBe('review');
  expect(tomato.trigger).toEqual({ kind: 'command', detail: '!tomato' });
  expect(tomato.actions.map((a) => a.kind)).toEqual(['chat', 'scene']);
  expect(tomato.review.join(' ')).toMatch(/script/i);
  expect(tomato.intent).toContain('!tomato');
  expect(tomato.intent).toContain('Splat cam');
  expect(JSON.stringify(report)).not.toContain('process.exit');
  const cheer = byName('Cheer alert');
  expect(cheer.status).toBe('mapped');
  expect(cheer.trigger?.kind).toBe('cheer');
  expect(cheer.actions.map((a) => a.kind)).toEqual(['media', 'source-visibility']);
  expect(cheer.actions[0]!.detail).toBe('cheer.mp3');
  expect(byName('!off').status).toBe('skipped');
  expect(byName('Raid').status).toBe('skipped');
  const preset = byName('Confetti');
  expect(preset.status).toBe('review');
  expect(preset.review.join(' ')).toMatch(/program/i);
  expect(report.items.find((i) => /timer/i.test(i.name))?.status).toBe('skipped');
  expect(report.counts).toEqual({
    imported: report.items.filter((i) => i.status !== 'skipped').length,
    mapped: 1,
    review: report.items.filter((i) => i.status === 'review').length,
    skipped: report.items.filter((i) => i.status === 'skipped').length,
  });
});

it('reads a Streamer.bot export as JSON or as an encoded import string', () => {
  const json = readNativeImport('streamerbot', JSON.stringify(streamerbotExport));
  const encoded = Buffer.concat([
    Buffer.from('SBAE'),
    gzipSync(Buffer.from(JSON.stringify(streamerbotExport))),
  ]).toString('base64');
  const fromString = readNativeImport('streamerbot', encoded);
  expect(fromString.items).toEqual(json.items);
  const hit = json.items.find((i) => i.name === 'Tomato hit')!;
  expect(hit.trigger).toEqual({ kind: 'command', detail: '!tomato' });
  expect(hit.review.join(' ')).toMatch(/cheer|second trigger|additional/i);
  expect(hit.actions.map((a) => a.kind)).toEqual(['scene', 'source-visibility', 'chat']);
  expect(hit.review.join(' ')).toMatch(/C#/);
  expect(JSON.stringify(json)).not.toContain('Environment.Exit');
  expect(hit.bridge).toBe('Tomato hit');
  expect(json.items.find((i) => i.name === 'Old')?.status).toBe('skipped');
  const raid = json.items.find((i) => i.name === 'Raid shoutout')!;
  expect(raid.status).toBe('mapped');
  expect(raid.intent).toMatch(/raid/i);
});

it('reads an OBS scene collection without leaking source URLs, keys or running scripts', () => {
  const report = readNativeImport('obs', JSON.stringify(obsCollection));
  expect(report.title).toBe('Streaming');
  const names = report.items.map((i) => `${i.kind}:${i.name}:${i.status}`);
  expect(names).toContain('scene:Main:imported');
  expect(names).toContain('scene:BRB:imported');
  expect(names).toContain('script:auto.lua:review');
  expect(names).toContain('source:Plugin thing:skipped');
  const riff = report.items.find((i) => i.name === 'Riff')!;
  expect(riff.reason).toMatch(/riff\.example/);
  expect(JSON.stringify(report)).not.toContain('secret-overlay-key');
  expect(JSON.stringify(report)).not.toContain('/Users/me');
  expect(report.items.every((i) => i.bridge === null)).toBe(true);
  expect(report.notes.join(' ')).toMatch(/auto-scene-switcher/);
});

it('rejects oversized, unreadable and decompression-bomb input with a clear reason', () => {
  expect(() => readNativeImport('obs', 'x'.repeat(300 * 1024))).toThrow(/KiB/);
  expect(() => readNativeImport('firebot', '{not json')).toThrow(/JSON/);
  expect(() => readNativeImport('firebot', JSON.stringify({ hello: 1 }))).toThrow(/Firebot setup/);
  const bomb = Buffer.concat([
    Buffer.from('SBAE'),
    gzipSync(Buffer.alloc(8 * 1024 * 1024, 32)),
  ]).toString('base64');
  expect(() => readNativeImport('streamerbot', bomb)).toThrow(/too large/i);
});

it('creates reviewable drafts idempotently and never approves them', () => {
  const s = setup();
  const text = JSON.stringify(streamerbotExport);
  const first = s.service.previewImport({ tool: 'streamerbot', text });
  const second = s.service.previewImport({ tool: 'streamerbot', text });
  expect(second.items.map((i) => i.id)).toEqual(first.items.map((i) => i.id));
  const hit = first.items.find((i) => i.name === 'Tomato hit')!;
  const raid = first.items.find((i) => i.name === 'Raid shoutout')!;
  const decisions = [
    { id: hit.id, decision: 'bridge' as const, versionId: s.version.id, control: 'start' as const },
    { id: raid.id, decision: 'intent' as const },
  ];
  const drafted = s.service.draftImport({ tool: 'streamerbot', text, decisions });
  expect(drafted.intents).toEqual([{ id: raid.id, name: 'Raid shoutout', text: raid.intent }]);
  const review = drafted.state.mappingReview!;
  expect(review.mappings).toEqual([
    {
      id: `import-${hit.id}`,
      eventName: 'Tomato hit',
      versionId: s.version.id,
      control: 'start',
      actionId: null,
      tool: 'streamerbot',
    },
  ]);
  expect(drafted.state.mappings).toEqual([]);
  expect(drafted.report.items.find((i) => i.id === hit.id)?.drafted).toBe('bridge');
  expect(drafted.report.items.find((i) => i.id === raid.id)?.drafted).toBe('intent');
  // Re-import: the same items are recognised as drafted and produce the same review.
  const again = s.service.previewImport({ tool: 'streamerbot', text });
  expect(again.items.find((i) => i.id === hit.id)?.drafted).toBe('bridge');
  const redrafted = s.service.draftImport({ tool: 'streamerbot', text, decisions });
  expect(redrafted.state.mappingReview!.mappings).toEqual(review.mappings);
});

it('refuses decisions that do not match the report', () => {
  const s = setup();
  const text = JSON.stringify(obsCollection);
  const report = s.service.previewImport({ tool: 'obs', text });
  expect(() =>
    s.service.draftImport({
      tool: 'obs',
      text,
      decisions: [{ id: 'f'.repeat(16), decision: 'intent' }],
    }),
  ).toThrow(/no longer/);
  const scene = report.items.find((i) => i.kind === 'scene')!;
  expect(() =>
    s.service.draftImport({
      tool: 'obs',
      text,
      decisions: [{ id: scene.id, decision: 'bridge', versionId: s.version.id, control: 'start' }],
    }),
  ).toThrow(/bridge/);
});

it('serves import preview and drafts through guarded routes', async () => {
  const app = await createApp({ logger: false, secret: 's'.repeat(32) });
  apps.push(app);
  const payload = { tool: 'firebot', text: JSON.stringify(firebotSetup) };
  expect(
    (await app.inject({ method: 'POST', url: '/api/production/import/preview', payload }))
      .statusCode,
  ).toBe(403);
  const preview = await app.inject({
    method: 'POST',
    url: '/api/production/import/preview',
    headers: { 'x-riff-request': '1' },
    payload,
  });
  expect(preview.statusCode).toBe(200);
  const cheer = preview
    .json()
    .report.items.find((i: { name: string }) => i.name === 'Cheer alert') as { id: string };
  const drafts = await app.inject({
    method: 'POST',
    url: '/api/production/import/drafts',
    headers: { 'x-riff-request': '1' },
    payload: { ...payload, decisions: [{ id: cheer.id, decision: 'intent' }] },
  });
  expect(drafts.statusCode).toBe(200);
  expect(drafts.json().intents[0].text).toMatch(/cheer/i);
  const bad = await app.inject({
    method: 'POST',
    url: '/api/production/import/preview',
    headers: { 'x-riff-request': '1' },
    payload: { tool: 'firebot', text: '{nope' },
  });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().message).toMatch(/JSON/);
});
