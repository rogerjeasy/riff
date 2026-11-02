import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParticipationLanguage, PermissionManifest } from '@riff/sdk';
import { compileOffline } from '@riff/compiler';
import { verifyCandidate, manifestSchema } from '@riff/sandbox';
import { createApp, type RiffApp } from '../src/app.js';
const apps: RiffApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
async function setup(now?: () => number) {
  const app = await createApp({ logger: false, ...(now ? { now } : {}) });
  apps.push(app);
  return app;
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
it('exposes only current approved public guidance and retains explicit broadcast preferences', async () => {
  const app = await setup();
  const v = await live(app);
  const initial = (await app.inject('/api/participation')).json().settings;
  const changed = await app.inject({
    method: 'POST',
    url: '/api/participation/settings',
    headers: { 'x-riff-request': '1' },
    payload: {
      expectedRevision: 0,
      settings: {
        ...initial,
        revision: undefined,
        language: 'fr',
        reducedMotion: true,
        highContrast: true,
        effectLabels: true,
      },
    },
  });
  expect(changed.statusCode).toBe(200);
  const guidance = (await app.inject('/participation?language=fr')).json();
  expect(guidance.interactions).toHaveLength(1);
  expect(guidance.interactions[0].instructions.join(' ')).toContain('!tomato');
  expect(guidance.interactions[0].instructions.join(' ')).toContain('Tout le monde');
  expect(guidance.interactions[0].free).toBe(true);
  expect(JSON.stringify(guidance)).not.toMatch(
    /PRIVATE|overlayKey|viewerId|participants|source|artifactId/,
  );
  expect(app.riff.participation.presentation(v.id, null)).toMatchObject({
    reducedMotion: true,
    highContrast: true,
  });
  app.riff.studio.pause(v.automationId);
  expect((await app.inject('/participation')).json().interactions[0].phase).toBe('paused');
  expect(app.riff.participation.settings().language).toBe('fr');
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/participation/settings',
        headers: { 'x-riff-request': '1' },
        payload: {
          expectedRevision: 0,
          settings: {
            language: 'en',
            reducedMotion: false,
            highContrast: false,
            effectLabels: false,
          },
        },
      })
    ).statusCode,
  ).toBe(409);
});
it('rate limits late help independently, deduplicates events, and cannot authorize panic', async () => {
  let at = 100000;
  const app = await setup(() => at);
  const v = await live(app);
  const event = (id: string, viewerId: string, text = '!riff help fr') => ({
    id,
    viewerId,
    text,
    channelId: app.riff.repo.channelId,
    viewerName: 'Synthetic viewer',
    roles: ['viewer'] as ['viewer'],
    source: 'twitch' as const,
  });
  expect(app.riff.participation.help(event('one', 'alice')).accepted).toBe(true);
  expect(app.riff.participation.help(event('two', 'alice')).accepted).toBe(false);
  expect(app.riff.participation.help(event('one', 'bob')).accepted).toBe(false);
  expect(app.riff.participation.help(event('three', 'bob')).accepted).toBe(true);
  expect(app.riff.participation.presentation(v.id, null)?.instructions.join(' ')).toContain(
    'Tout le monde',
  );
  for (let i = 0; i < 4; i++)
    expect(app.riff.participation.help(event('other' + i, 'viewer' + i)).accepted).toBe(true);
  expect(app.riff.participation.help(event('overflow', 'viewer9')).accepted).toBe(false);
  await app.riff.runtime.handleChat(event('panic', 'alice', '!riff panic'));
  expect(app.riff.runtime.panicked).toBe(false);
  at += 60001;
  expect(app.riff.participation.help(event('renew', 'alice')).accepted).toBe(true);
  app.riff.studio.panic('test stop');
  expect(app.riff.participation.help(event('after-stop', 'charlie')).accepted).toBe(false);
  expect((await app.inject('/participation')).json().interactions).toEqual([]);
});
it('keeps public participation available behind console authentication but protects settings', async () => {
  const app = await createApp({
    logger: false,
    secret: 'p'.repeat(32),
    console: { password: 'a-long-test-password', accessToken: null },
  });
  apps.push(app);
  expect((await app.inject('/api/participation')).statusCode).toBe(401);
  expect((await app.inject('/participation')).statusCode).toBe(200);
  expect((await app.inject('/participation?language=unknown')).statusCode).toBe(400);
});
it('persists help admission and preferences across service recreation and keeps channel scopes separate', async () => {
  const { createParticipationService } = await import('../src/services/participation/service.js');
  const { openDatabase } = await import('../src/db/client.js');
  const { forChannel } = await import('../src/db/repositories/studio.js');
  const { migrateConnection } = await import('../src/app.js');
  const db = openDatabase(':memory:');
  migrateConnection(db);
  try {
    const a = forChannel(db, 'a'),
      b = forChannel(db, 'b');
    a.ensure('A');
    b.ensure('B');
    let at = 100000;
    const make = (repo: typeof a) =>
      createParticipationService({
        database: db,
        repo,
        blocked: () => false,
        changed: () => {},
        now: () => at,
      });
    const first = make(a);
    first.save(0, { language: 'es', reducedMotion: true, highContrast: true, effectLabels: true });
    const message = {
      id: 'persisted',
      channelId: 'a',
      viewerId: 'viewer',
      viewerName: 'Viewer',
      roles: ['viewer'] as ['viewer'],
      source: 'twitch' as const,
      text: '!riff help es',
    };
    expect(first.help(message).accepted).toBe(true);
    first.close();
    const restarted = make(a),
      other = make(b);
    expect(restarted.settings()).toMatchObject({
      revision: 1,
      language: 'es',
      reducedMotion: true,
    });
    expect(other.settings().language).toBe('inherit');
    at += 31000;
    expect(restarted.help(message).accepted).toBe(false);
    expect(other.help({ ...message, channelId: 'b' }).accepted).toBe(true);
    restarted.close();
    other.close();
  } finally {
    db.close();
  }
});
it('shows resource limits, objectives and aggregate outcomes without exposing live participants', async () => {
  const app = await setup();
  const out = compileOffline({
    intent:
      'Community Goal: everyone uses !grow to contribute hearts, with 3 contributions per participant in a 120 second round. Work together toward a collective goal of 5 points.',
    base: null,
  });
  const verification = await verifyCandidate({
    source: out.source!,
    manifest: out.manifest,
    tests: out.tests,
  });
  expect(verification.ok).toBe(true);
  const manifest = manifestSchema.parse(out.manifest);
  expect(manifest.experience).toBeTruthy();
  const v = app.riff.repo.insertVersion({
    automationId: app.riff.repo.createAutomation('Repair').id,
    parentVersionId: null,
    artifactId: verification.artifactId,
    title: 'Repair',
    intent: 'PRIVATE',
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
  await app.riff.runtime.handleChat({
    id: 'contribution',
    channelId: app.riff.repo.channelId,
    viewerId: 'PRIVATE-VIEWER',
    viewerName: 'PRIVATE-NAME',
    roles: ['viewer'],
    source: 'twitch',
    text: manifest.trigger.command,
  });
  const view = app.riff.participation.view('de');
  expect(view.interactions[0]?.instructions.join(' ')).toContain('pro Person und Runde');
  expect(view.interactions[0]?.remainingMs).toBeGreaterThan(0);
  expect(JSON.stringify(view)).not.toContain('PRIVATE');
  app.riff.participation.save(0, {
    language: 'fr',
    reducedMotion: true,
    highContrast: false,
    effectLabels: true,
  });
  expect(
    app.riff.participation.presentation(v.id, {
      language: 'es',
      reducedMotion: false,
      instructions: ['Canal · public'],
    }),
  ).toMatchObject({ reducedMotion: true });
  expect(app.riff.participation.presentation(v.id, null)?.instructions.join(' ')).toContain(
    'par manche',
  );
  // F29: a remix's reviewed headline leads in the channel language and its accent is carried.
  const styled = app.riff.participation.presentation(v.id, {
    language: 'es',
    reducedMotion: false,
    instructions: [],
    accent: '#8ecae6',
    headline: { en: 'Splat away', fr: 'Tomatez !' },
  });
  expect(styled?.instructions[0]).toBe('Tomatez !');
  expect(styled).toMatchObject({ accent: '#8ecae6' });
});
it('exports broadcast accessibility and preserves explicitly adopted preferences through recipient review', async () => {
  const a = await setup(),
    b = await setup(),
    v = await live(a);
  a.riff.participation.save(0, {
    language: 'fr',
    reducedMotion: true,
    highContrast: true,
    effectLabels: true,
  });
  const pack = a.riff.recipes.export({
    versionId: v.id,
    title: 'Accessible tomatoes',
    description: 'Public example',
    author: 'Creator',
    license: 'MIT',
    rightsAttested: true,
  });
  expect(pack.presentation).toMatchObject({
    language: 'fr',
    reducedMotion: true,
    highContrast: true,
    effectLabels: true,
  });
  b.riff.recipes.import(pack);
  const { revision, ...profile } = b.riff.recipes.state().profile;
  b.riff.recipes.saveProfile(revision, { ...profile, ...pack.presentation });
  const review = await b.riff.recipes.adapt({
    sourceDigest: pack.digest,
    profileRevision: 1,
    generate: false,
  });
  const installed = b.riff.recipes.install({ reviewId: review.id, digest: review.digest });
  const presentation = b.riff.participation.presentation(
    installed.versionId,
    b.riff.recipes.presentation(installed.versionId),
  );
  expect(presentation).toMatchObject({
    reducedMotion: true,
    highContrast: true,
    effectLabels: true,
  });
  expect(presentation?.instructions.join(' ')).toContain('Tout le monde');
});
it('keeps every team command intact when labels and commands reach their supported lengths', async () => {
  const { ruleCopy } = await import('../src/services/participation/copy.js');
  const out = compileOffline({
    intent:
      'Community Goal: everyone uses !grow to contribute hearts, with 3 contributions per participant in a 120 second round. Work together toward a collective goal of 5 points.',
    base: null,
  });
  const manifest = manifestSchema.parse(out.manifest);
  manifest.experience!.teams = Array.from({ length: 8 }, (_, i) => ({
    id: 'team' + i,
    label: 'Long public team label ' + i,
    joinCommand: '!' + String(i).repeat(32),
  }));
  const guidance = ruleCopy(manifest, 'de');
  for (const team of manifest.experience!.teams)
    expect(guidance.instructions.join(' ')).toContain(team.joinCommand);
  expect(guidance.instructions.every((line) => line.length <= 200)).toBe(true);
});
it('plain help preserves each recipe language and clears rather than extends a prior override', async () => {
  let at = 100000;
  const app = await setup(() => at),
    french = await live(app),
    spanish = await live(app);
  const fr = { language: 'fr' as const, reducedMotion: false, instructions: [] };
  const es = { language: 'es' as const, reducedMotion: false, instructions: [] };
  const guidance = () => [
    app.riff.participation.presentation(french.id, fr)?.instructions.join(' '),
    app.riff.participation.presentation(spanish.id, es)?.instructions.join(' '),
  ];
  const before = guidance();
  expect(before[0]).toContain('Tout le monde');
  expect(before[1]).not.toEqual(before[0]);
  let n = 0;
  const help = (text: string) =>
    app.riff.participation.help({
      id: 'help-' + ++n,
      viewerId: 'viewer-' + n,
      channelId: app.riff.repo.channelId,
      viewerName: 'Viewer',
      roles: ['viewer'],
      source: 'twitch',
      text,
    });
  expect(help('!riff help').accepted).toBe(true);
  expect(guidance()).toEqual(before);
  expect(help('!riff help de').accepted).toBe(true);
  expect(guidance()[0]).toContain('Alle');
  expect(guidance()[0]).toEqual(guidance()[1]);
  expect(guidance()).not.toEqual(before);
  at += 15001;
  expect(guidance()).toEqual(before);
  expect(help('!riff help de').accepted).toBe(true);
  at += 1000;
  expect(help('!riff help').accepted).toBe(true);
  expect(guidance()).toEqual(before);
});

describe('reviewed rule copy for every manifest shape and language', () => {
  const nb = ' ';
  const trigger = (audience: PermissionManifest['trigger']['audience'], windowMs = 60000) => ({
    command: '!tomato',
    audience,
    maxPerViewer: 3,
    windowMs,
  });
  const experience = (
    patch: Partial<NonNullable<PermissionManifest['experience']>>,
  ): NonNullable<PermissionManifest['experience']> => ({
    version: 1,
    title: 'Push',
    durationMs: 120000,
    maxParticipants: 256,
    teams: [],
    resource: { name: 'pushes', perParticipant: 5 },
    contribution: { command: '!push', points: 1 },
    objective: { kind: 'highest-score', target: null },
    ...patch,
  });
  const manifest = (
    audience: PermissionManifest['trigger']['audience'],
    exp: PermissionManifest['experience'] = null,
    windowMs = 60000,
  ): PermissionManifest => ({
    sdkVersion: exp ? '0.4.0' : '0.3.0',
    capabilities: exp ? ['overlay', 'session'] : ['overlay'],
    trigger: { ...trigger(audience, windowMs), command: exp?.contribution.command ?? '!tomato' },
    limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
    experience: exp,
  });
  const teams = [
    { id: 'red', label: 'Red', joinCommand: '!red' },
    { id: 'blue', label: 'Blue', joinCommand: '!blue' },
  ];
  const shapes = {
    statelessEveryone: manifest(['viewer']),
    statelessRestricted: manifest(['subscriber', 'moderator'], null, 300000),
    teamsHighest: manifest(['viewer'], experience({ teams })),
    teamlessHighest: manifest(['viewer'], experience({})),
    collectiveGoal: manifest(
      ['viewer'],
      experience({
        resource: { name: 'hearts', perParticipant: 3 },
        contribution: { command: '!grow', points: 1 },
        objective: { kind: 'collective-goal', target: 50 },
      }),
    ),
    maxParticipants: manifest(['subscriber'], experience({ teams, maxParticipants: 20 })),
  };
  const expected: Record<
    ParticipationLanguage,
    Record<keyof typeof shapes, { instructions: string[]; objective: string }>
  > = {
    en: {
      statelessEveryone: {
        instructions: ['Everyone: type !tomato · 3 per viewer in any 60 seconds'],
        objective: 'Free: trigger the on-stream effect from chat',
      },
      statelessRestricted: {
        instructions: [
          'Only subscribers and moderators: type !tomato · 3 per viewer in any 5 minutes',
        ],
        objective: 'Trigger the on-stream effect from chat',
      },
      teamsHighest: {
        instructions: [
          'Everyone · Join a team: Red !red / Blue !blue',
          'Then type !push · 5 pushes per player per round',
        ],
        objective: 'Highest team score wins',
      },
      teamlessHighest: {
        instructions: ['Everyone: type !push · 5 pushes per player per round'],
        objective: 'Score as many points together as possible',
      },
      collectiveGoal: {
        instructions: ['Everyone: type !grow · 3 hearts per player per round'],
        objective: 'Goal: 50 points together',
      },
      maxParticipants: {
        instructions: [
          'Only subscribers · Join a team: Red !red / Blue !blue',
          'Then type !push · 5 pushes per player per round · Up to 20 players',
        ],
        objective: 'Highest team score wins',
      },
    },
    fr: {
      statelessEveryone: {
        instructions: [
          `Tout le monde${nb}: tapez !tomato · 3 par spectateur sur toute période de 60 secondes`,
        ],
        objective: `Gratuit${nb}: déclenchez l’effet à l’écran depuis le chat`,
      },
      statelessRestricted: {
        instructions: [
          `Réservé aux abonnés et aux modérateurs${nb}: tapez !tomato · 3 par spectateur sur toute période de 5 minutes`,
        ],
        objective: 'Déclenchez l’effet à l’écran depuis le chat',
      },
      teamsHighest: {
        instructions: [
          `Tout le monde · Rejoignez une équipe${nb}: Red !red / Blue !blue`,
          'Puis tapez !push · 5 pushes par joueur et par manche',
        ],
        objective: 'L’équipe au meilleur score gagne',
      },
      teamlessHighest: {
        instructions: [`Tout le monde${nb}: tapez !push · 5 pushes par joueur et par manche`],
        objective: 'Marquez ensemble un maximum de points',
      },
      collectiveGoal: {
        instructions: [`Tout le monde${nb}: tapez !grow · 3 hearts par joueur et par manche`],
        objective: `Objectif${nb}: 50 points ensemble`,
      },
      maxParticipants: {
        instructions: [
          `Réservé aux abonnés · Rejoignez une équipe${nb}: Red !red / Blue !blue`,
          'Puis tapez !push · 5 pushes par joueur et par manche · Jusqu’à 20 joueurs',
        ],
        objective: 'L’équipe au meilleur score gagne',
      },
    },
    es: {
      statelessEveryone: {
        instructions: [
          'Todos: escribe !tomato · 3 por espectador en cualquier periodo de 60 segundos',
        ],
        objective: 'Gratis: activa el efecto en pantalla desde el chat',
      },
      statelessRestricted: {
        instructions: [
          'Solo suscriptores y moderadores: escribe !tomato · 3 por espectador en cualquier periodo de 5 minutos',
        ],
        objective: 'Activa el efecto en pantalla desde el chat',
      },
      teamsHighest: {
        instructions: [
          'Todos · Únete a un equipo: Red !red / Blue !blue',
          'Luego escribe !push · 5 pushes por jugador y ronda',
        ],
        objective: 'Gana el equipo con más puntos',
      },
      teamlessHighest: {
        instructions: ['Todos: escribe !push · 5 pushes por jugador y ronda'],
        objective: 'Suma con todos el máximo de puntos posible',
      },
      collectiveGoal: {
        instructions: ['Todos: escribe !grow · 3 hearts por jugador y ronda'],
        objective: 'Objetivo: 50 puntos entre todos',
      },
      maxParticipants: {
        instructions: [
          'Solo suscriptores · Únete a un equipo: Red !red / Blue !blue',
          'Luego escribe !push · 5 pushes por jugador y ronda · Hasta 20 jugadores',
        ],
        objective: 'Gana el equipo con más puntos',
      },
    },
    de: {
      statelessEveryone: {
        instructions: [
          'Alle: schreibe !tomato · 3 pro Zuschauer in jedem Zeitraum von 60 Sekunden',
        ],
        objective: 'Kostenlos: Löse den Effekt im Stream über den Chat aus',
      },
      statelessRestricted: {
        instructions: [
          'Nur Abonnenten und Moderatoren: schreibe !tomato · 3 pro Zuschauer in jedem Zeitraum von 5 Minuten',
        ],
        objective: 'Löse den Effekt im Stream über den Chat aus',
      },
      teamsHighest: {
        instructions: [
          'Alle · Tritt einem Team bei: Red !red / Blue !blue',
          'Dann schreibe !push · 5 pushes pro Person und Runde',
        ],
        objective: 'Das Team mit den meisten Punkten gewinnt',
      },
      teamlessHighest: {
        instructions: ['Alle: schreibe !push · 5 pushes pro Person und Runde'],
        objective: 'Sammle mit allen so viele Punkte wie möglich',
      },
      collectiveGoal: {
        instructions: ['Alle: schreibe !grow · 3 hearts pro Person und Runde'],
        objective: 'Ziel: 50 Punkte gemeinsam',
      },
      maxParticipants: {
        instructions: [
          'Nur Abonnenten · Tritt einem Team bei: Red !red / Blue !blue',
          'Dann schreibe !push · 5 pushes pro Person und Runde · Bis zu 20 Personen',
        ],
        objective: 'Das Team mit den meisten Punkten gewinnt',
      },
    },
  };
  for (const language of ['en', 'fr', 'es', 'de'] as const)
    for (const shape of Object.keys(shapes) as (keyof typeof shapes)[])
      it(`${language} · ${shape}`, async () => {
        const { ruleCopy } = await import('../src/services/participation/copy.js');
        // Every fixture is a valid host manifest, so the copy describes what the engine enforces.
        expect(manifestSchema.safeParse(shapes[shape]).success).toBe(true);
        expect(ruleCopy(shapes[shape], language)).toEqual(expected[language][shape]);
      });
  it('names the broadcaster, singular units and fractional windows correctly', async () => {
    const { ruleCopy } = await import('../src/services/participation/copy.js');
    const m = manifest(['subscriber', 'moderator', 'broadcaster'], null, 1500);
    m.trigger.maxPerViewer = 1;
    expect(ruleCopy(m, 'en').instructions[0]).toBe(
      'Only subscribers, moderators and the broadcaster: type !tomato · 1 per viewer in any 1.5 seconds',
    );
    expect(ruleCopy(m, 'fr').instructions[0]).toBe(
      `Réservé aux abonnés, aux modérateurs et au créateur${nb}: tapez !tomato · 1 par spectateur sur toute période de 1,5 seconde`,
    );
    m.trigger.windowMs = 1000;
    expect(ruleCopy(m, 'de').instructions[0]).toBe(
      'Nur Abonnenten, Moderatoren und der Streamer: schreibe !tomato · 1 pro Zuschauer in jedem Zeitraum von 1 Sekunde',
    );
    expect(ruleCopy(m, 'es').instructions[0]).toBe(
      'Solo suscriptores, moderadores y el creador: escribe !tomato · 1 por espectador en cualquier periodo de 1 segundo',
    );
    const goal = manifest(
      ['viewer'],
      experience({ objective: { kind: 'collective-goal', target: 1 } }),
    );
    expect(ruleCopy(goal, 'en').objective).toBe('Goal: 1 point together');
    expect(ruleCopy(goal, 'de').objective).toBe('Ziel: 1 Punkt gemeinsam');
  });
});

const helpMessage = (app: RiffApp, id: string, text: string) => ({
  id,
  viewerId: 'viewer-' + id,
  channelId: app.riff.repo.channelId,
  viewerName: 'Viewer',
  roles: ['viewer'] as ['viewer'],
  source: 'twitch' as const,
  text,
});

it('plain help visibly highlights the on-stream guidance for 15 seconds', async () => {
  let at = 100000;
  const app = await setup(() => at);
  const v = await live(app);
  const frames: { type: string; payload: { scenes?: { help?: boolean }[] } }[] = [];
  app.riff.overlay.attach(
    { send: (data: string) => frames.push(JSON.parse(data)), close: () => {} },
    'test',
  );
  const lastScenes = () => frames.filter((f) => f.type === 'scenes').at(-1)?.payload.scenes ?? [];
  expect(app.riff.participation.presentation(v.id, null)?.help).toBeUndefined();
  expect(lastScenes()[0]?.help).toBeUndefined();
  expect(app.riff.participation.help(helpMessage(app, 'plain', '!riff help')).accepted).toBe(true);
  expect(app.riff.participation.presentation(v.id, null)?.help).toBe(true);
  expect(lastScenes()[0]?.help).toBe(true);
  at += 15001;
  expect(app.riff.participation.presentation(v.id, null)?.help).toBeUndefined();
});

it('a viewer language request never overrides an explicit broadcast language', async () => {
  const app = await setup();
  const v = await live(app);
  app.riff.participation.save(0, {
    language: 'fr',
    reducedMotion: false,
    highContrast: false,
    effectLabels: false,
  });
  expect(app.riff.participation.help(helpMessage(app, 'de', '!riff help de')).accepted).toBe(true);
  const shown = app.riff.participation.presentation(v.id, null);
  expect(shown?.instructions.join(' ')).toContain('Tout le monde');
  expect(shown?.instructions.join(' ')).not.toContain('Alle');
  expect(shown?.help).toBe(true);
});

it('carries a recipe display name structurally even when it contains the separator', async () => {
  const app = await setup();
  const v = await live(app);
  const shown = app.riff.participation.presentation(v.id, {
    language: 'en',
    reducedMotion: false,
    displayName: 'Night · Shift',
    instructions: ['Night · Shift · Tomato'],
  });
  expect(shown?.instructions[0]).toBe(
    'Night · Shift · Everyone: type !tomato · 3 per viewer in any 60 seconds',
  );
});

it('accepts cache-busters, names invalid query and settings fields, and exposes machine-readable rules', async () => {
  const app = await setup();
  await live(app);
  const ok = await app.inject('/participation?language=fr&_=1730000000');
  expect(ok.statusCode).toBe(200);
  expect(ok.json().language).toBe('fr');
  expect(ok.json().interactions[0]).toMatchObject({
    command: '!tomato',
    joinCommands: [],
    audience: ['viewer'],
    goal: null,
  });
  const bad = await app.inject('/participation?language=xx');
  expect(bad.statusCode).toBe(400);
  expect(bad.json().message).toMatch(/language/);
  const twice = await app.inject('/participation?language=en&language=fr');
  expect(twice.statusCode).toBe(400);
  expect(twice.json().message).toMatch(/language/);
  const settings = await app.inject({
    method: 'POST',
    url: '/api/participation/settings',
    headers: { 'x-riff-request': '1' },
    payload: {
      expectedRevision: 0,
      settings: { language: 'xx', reducedMotion: false, highContrast: false, effectLabels: false },
    },
  });
  expect(settings.statusCode).toBe(400);
  expect(settings.json().message).toMatch(/settings\.language/);
});

it('reports collective goal progress and join commands', async () => {
  const app = await setup();
  const out = compileOffline({
    intent:
      'Community Goal: everyone uses !grow to contribute hearts, with 3 contributions per participant in a 120 second round. Work together toward a collective goal of 5 points.',
    base: null,
  });
  const verification = await verifyCandidate({
    source: out.source!,
    manifest: out.manifest,
    tests: out.tests,
  });
  const manifest = manifestSchema.parse(out.manifest);
  const v = app.riff.repo.insertVersion({
    automationId: app.riff.repo.createAutomation('Grow').id,
    parentVersionId: null,
    artifactId: verification.artifactId,
    title: 'Grow',
    intent: 'PRIVATE',
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
  await app.riff.runtime.handleChat({
    ...helpMessage(app, 'c1', manifest.trigger.command),
    roles: ['viewer'],
  });
  const interaction = app.riff.participation.view('en').interactions[0]!;
  expect(interaction.command).toBe(manifest.trigger.command);
  expect(interaction.goal).toEqual({
    target: manifest.experience!.objective.target,
    current: manifest.experience!.contribution.points,
  });
  expect(interaction.objective).toBe(
    `Goal: ${manifest.experience!.objective.target} points together`,
  );
});

it('caches public guidance briefly and rate limits each client', async () => {
  let at = 100000;
  const app = await setup(() => at);
  await live(app);
  const spy = vi.spyOn(app.riff.repo, 'version');
  expect((await app.inject('/participation')).statusCode).toBe(200);
  const first = spy.mock.calls.length;
  expect(first).toBeGreaterThan(0);
  expect((await app.inject('/participation')).statusCode).toBe(200);
  expect(spy.mock.calls.length).toBe(first);
  at += 1001;
  expect((await app.inject('/participation')).statusCode).toBe(200);
  expect(spy.mock.calls.length).toBeGreaterThan(first);
  let limited: Awaited<ReturnType<typeof app.inject>> | undefined;
  for (let i = 0; i < 80 && !limited; i++) {
    const response = await app.inject('/participation');
    if (response.statusCode === 429) limited = response;
  }
  expect(limited?.json().message).toMatch(/Too many/);
  expect(limited?.headers['retry-after']).toBeTruthy();
});

it('keeps pre-F40 recipe digests by omitting false contrast and label presentation keys', async () => {
  const app = await setup();
  const v = await live(app);
  const pack = app.riff.recipes.export({
    versionId: v.id,
    title: 'Plain tomatoes',
    description: 'Public example',
    author: 'Creator',
    license: 'MIT',
    rightsAttested: true,
  });
  expect(Object.keys(pack.presentation).sort()).toEqual(['language', 'reducedMotion']);
  app.riff.participation.save(0, {
    language: 'inherit',
    reducedMotion: false,
    highContrast: true,
    effectLabels: false,
  });
  const contrast = app.riff.recipes.export({
    versionId: v.id,
    title: 'Plain tomatoes',
    description: 'Public example',
    author: 'Creator',
    license: 'MIT',
    rightsAttested: true,
  });
  expect(contrast.presentation).toEqual({
    language: pack.presentation.language,
    reducedMotion: false,
    highContrast: true,
  });
});
it('explains an approved opportunity-rotation policy on stream in the selected language (F37/F40)', async () => {
  const app = await setup();
  const v = await live(app);
  const director = (action: string, payload: object) =>
    app.inject({
      method: 'POST',
      url: `/api/director/${action}`,
      payload,
      headers: { 'x-riff-request': '1' },
    });
  const rotation = 'Priority to viewers who haven’t had a turn yet';
  const lines = () => app.riff.participation.presentation(v.id, null)?.instructions ?? [];
  const companion = async (query = '') =>
    (await app.inject(`/participation${query}`)).json().interactions[0];
  expect(lines()).not.toContain(rotation);
  const { DEFAULT_DIRECTOR_ENVELOPE } = await import('@riff/sdk');
  await director('draft', {
    expectedRevision: 0,
    envelope: { ...DEFAULT_DIRECTOR_ENVELOPE, participation: 'rotation' },
  });
  const rehearsed = (await director('rehearse', { expectedRevision: 1, versionId: v.id })).json()
    .state;
  const evidence = rehearsed.draft.evidence;
  expect(evidence.passed).toBe(true);
  // The private rehearsal shows the rotation reason in the console decision log.
  expect(
    evidence.telemetry.decisions.some((d: { reason: string }) =>
      d.reason.includes('Priority to viewers who haven’t had a turn yet.'),
    ),
  ).toBe(true);
  // Nothing is announced until the creator approves the policy.
  expect(lines()).not.toContain(rotation);
  await director('approve', {
    expectedRevision: rehearsed.revision,
    digest: rehearsed.draft.digest,
    evidenceHash: evidence.hash,
  });
  expect(lines()).toContain(rotation);
  expect((await companion()).instructions).toContain(rotation);
  expect((await companion('?language=fr')).instructions).toContain(
    'Priorité aux spectateurs qui n’ont pas encore eu leur tour',
  );
  expect(
    app.riff.participation.presentation(v.id, {
      language: 'de',
      reducedMotion: false,
      instructions: [],
    })?.instructions,
  ).toContain('Vorrang für Zuschauer, die noch nicht an der Reihe waren');
  // Rotation never gates participation: the command stays free for everyone.
  expect(await companion()).toMatchObject({ free: true, audience: ['viewer'] });
  await director('stop', {});
  expect(lines()).not.toContain(rotation);
});
