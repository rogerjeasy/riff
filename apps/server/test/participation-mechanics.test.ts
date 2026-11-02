import { afterEach, describe, expect, it } from 'vitest';
import type { ExperienceDefinition, PermissionManifest } from '@riff/sdk';
import { compileOffline } from '@riff/compiler';
import { manifestSchema, verifyCandidate } from '@riff/sandbox';
import { createApp, type RiffApp } from '../src/app.js';
import {
  MECHANICS_COPY,
  mechanicsCopy,
  phaseCopy,
  ruleCopy,
} from '../src/services/participation/copy.js';
import type { LiveChatMessage } from '../src/services/live/runtime.js';

/*
 * F40 coverage for definition version 2 mechanics: every reviewed phrase exists in every
 * language with identical placeholders, late-arrival help explains burst/health/match/
 * unlock rules in the selected language, and elimination keeps its own outcome text.
 */

const LANGUAGES = ['en', 'fr', 'es', 'de'] as const;
const placeholders = (phrase: string | { one: string; other: string }) =>
  [
    ...new Set(
      (typeof phrase === 'string' ? phrase : `${phrase.one} ${phrase.other}`).match(/\{\w+\}/g),
    ),
  ].sort();

const siege: ExperienceDefinition = {
  version: 2,
  title: 'Castle Siege',
  durationMs: 60_000,
  maxParticipants: 64,
  teams: [
    { id: 'red', label: 'Red', joinCommand: '!red' },
    { id: 'blue', label: 'Blue', joinCommand: '!blue' },
  ],
  resource: { name: 'attacks', perParticipant: 3 },
  contribution: { command: '!attack', points: 1 },
  objective: { kind: 'highest-score', target: null },
  mechanics: {
    match: { rounds: 3, intermissionMs: 5000 },
    health: { label: 'Health', max: 100, damage: 10, heal: { command: '!heal', amount: 5 } },
    burst: {
      command: '!shield',
      label: 'Shield',
      participants: 5,
      windowMs: 10_000,
      points: 0,
      limit: 3,
      shieldMs: 8000,
    },
    milestones: [
      { id: 'boost', label: 'Boost', score: 20, unlock: { command: '!boost', points: 2 } },
    ],
  },
};
const manifest = (experience: ExperienceDefinition): PermissionManifest => ({
  sdkVersion: '0.4.0',
  capabilities: ['overlay', 'session'],
  experience,
  trigger: {
    command: experience.contribution.command,
    audience: ['viewer'],
    maxPerViewer: 3,
    windowMs: 60_000,
  },
  limits: { effectsPerEvent: 1, effectsPerMinute: 120 },
});

describe('reviewed version 2 mechanics copy', () => {
  it('has every key in every language with the same placeholders and plural shape', () => {
    const keys = Object.keys(MECHANICS_COPY.en).sort();
    for (const language of LANGUAGES) {
      expect(Object.keys(MECHANICS_COPY[language]).sort()).toEqual(keys);
      for (const key of keys) {
        const en = MECHANICS_COPY.en[key as keyof typeof MECHANICS_COPY.en];
        const phrase = MECHANICS_COPY[language][key as keyof typeof MECHANICS_COPY.en];
        expect(typeof phrase, `${language}.${key}`).toBe(typeof en);
        expect(placeholders(phrase), `${language}.${key}`).toEqual(placeholders(en));
        const forms = typeof phrase === 'string' ? [phrase] : [phrase.one, phrase.other];
        for (const form of forms) expect(form.trim(), `${language}.${key}`).not.toBe('');
      }
    }
  });

  it('explains burst, health, unlocks and best-of-N rules for late arrivals in each language', () => {
    const m = manifest(siege);
    expect(manifestSchema.safeParse(m).success).toBe(true);
    const rules = Object.fromEntries(
      LANGUAGES.map((language) => [language, ruleCopy(m, language)]),
    );
    expect(rules.en).toEqual({
      instructions: [
        'Everyone · Join a team: Red !red / Blue !blue',
        'Then type !attack · 3 attacks per player per round · Up to 64 players',
        '5 different viewers typing !shield within 10 seconds trigger Shield · Shield blocks damage for 8 seconds · Shield works up to 3 times per round',
        'Health: 100 per team · !attack removes 10 from every other team · !heal heals your team by 5 · A team at 0 is eliminated · Unlocks !boost at 20 points · Best of 3 rounds · each round starts fresh',
      ],
      objective: 'Last team standing wins',
    });
    const fr = rules.fr!.instructions.join(' · ');
    expect(fr).toContain(
      '5 spectateurs différents qui tapent !shield en 10 secondes déclenchent Shield',
    );
    expect(fr).toContain('Débloque !boost à 20 points');
    expect(fr).toContain('Au meilleur des 3 manches');
    expect(rules.fr!.objective).toBe('La dernière équipe en lice gagne');
    const es = rules.es!.instructions.join(' · ');
    expect(es).toContain(
      '5 espectadores distintos que escriban !shield en 10 segundos activan Shield',
    );
    expect(es).toContain('Desbloquea !boost al llegar a 20 puntos');
    expect(es).toContain('Un equipo con 0 queda eliminado');
    const de = rules.de!.instructions.join(' · ');
    expect(de).toContain(
      '5 verschiedene Zuschauer, die innerhalb von 10 Sekunden !shield schreiben, lösen Shield aus',
    );
    expect(de).toContain('Schaltet !boost ab 20 Punkten frei');
    expect(de).toContain('Best of 3');
    for (const language of LANGUAGES)
      for (const line of rules[language]!.instructions)
        expect(line.length).toBeLessThanOrEqual(200);
  });

  it('describes burst objectives and singular forms correctly', () => {
    const burst: ExperienceDefinition = {
      ...siege,
      teams: [],
      objective: { kind: 'burst', target: 1 },
      mechanics: {
        match: null,
        health: null,
        burst: { ...siege.mechanics!.burst!, command: null, points: 1, limit: 1, shieldMs: 0 },
        milestones: [{ id: 'one', label: 'Spark', score: 1, unlock: null }],
      },
    };
    const m = manifest(burst);
    expect(manifestSchema.safeParse(m).success).toBe(true);
    expect(ruleCopy(m, 'en').objective).toBe('Trigger Shield once to win');
    expect(ruleCopy(m, 'en').instructions.join(' · ')).toContain(
      'Each Shield scores 1 point · Shield works once per round · Spark at 1 point',
    );
    expect(ruleCopy(m, 'de').objective).toBe('Löse Shield einmal aus, um zu gewinnen');
    expect(ruleCopy(m, 'de').instructions.join(' · ')).toContain('Spark ab 1 Punkt');
    expect(mechanicsCopy('fr', 'burstGoal', { label: 'Bouclier', target: 3 }, 3)).toBe(
      'Déclenchez Bouclier 3 fois pour gagner',
    );
    expect(mechanicsCopy('es', 'burstGoal', { label: 'Escudo', target: 2 }, 2)).toBe(
      'Activa Escudo 2 veces para ganar',
    );
  });

  it('names elimination as its own outcome rather than a finished round', () => {
    expect(phaseCopy('en', 'elimination')).toBe('Last team standing');
    expect(phaseCopy('fr', 'elimination')).toBe('Dernière équipe en lice');
    expect(phaseCopy('es', 'elimination')).toBe('Último equipo en pie');
    expect(phaseCopy('de', 'elimination')).toBe('Letztes Team im Spiel');
    for (const language of LANGUAGES)
      expect(phaseCopy(language, 'elimination')).not.toBe(phaseCopy(language, 'finished'));
  });
});

const apps: RiffApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const chat = (app: RiffApp, id: string, text: string): LiveChatMessage => ({
  id,
  viewerId: `viewer-${id}`,
  viewerName: 'Viewer',
  text,
  channelId: app.riff.repo.channelId,
  roles: ['viewer'],
  source: 'twitch',
});

it('`!riff help fr` shows the version 2 rules, round and language on the stream projection', async () => {
  const at = 1000;
  const app = await createApp({ logger: false, now: () => at });
  apps.push(app);
  const scenes: { language?: string; instructions?: string[] }[] = [];
  app.riff.overlay.attach(
    {
      send: (data) => {
        const message = JSON.parse(data) as { type: string; payload: { scenes?: [] } };
        if (message.type === 'scenes') scenes.push(...(message.payload.scenes ?? []));
      },
      close() {},
    },
    'home',
  );
  const out = compileOffline({
    intent:
      'Tomato Battle best of 3: viewers join Red with !red or Blue with !blue, then use !throw to throw tomatoes. Give each participant 3 throws for a 60 second round with a 5 second break between rounds.',
    base: null,
  });
  const verification = await verifyCandidate({
    source: out.source!,
    manifest: out.manifest,
    tests: out.tests,
  });
  expect(verification.ok).toBe(true);
  const v = app.riff.repo.insertVersion({
    automationId: app.riff.repo.createAutomation('Tomato Battle').id,
    parentVersionId: null,
    artifactId: verification.artifactId,
    title: 'Tomato Battle',
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
  app.riff.studio.approve(v.id, { artifactId: v.artifactId!, activeVersionId: null });

  const english = app.riff.participation.presentation(v.id, null)!;
  expect(english.language).toBe('en');
  expect(english.instructions.join(' · ')).toContain('Best of 3 rounds · each round starts fresh');
  expect(english.instructions.at(-1)).toBe('Playing · Round 1 of 3 · Highest team score wins');

  await app.riff.runtime.handleChat(chat(app, 'help-fr', '!riff help fr'));
  const french = app.riff.participation.presentation(v.id, null)!;
  expect(french).toMatchObject({ language: 'fr', help: true });
  expect(french.instructions.length).toBeLessThanOrEqual(6);
  expect(french.instructions.join(' · ')).toContain(
    'Au meilleur des 3 manches · chaque manche repart de zéro',
  );
  expect(french.instructions.at(-1)).toBe(
    'En cours · Manche 1 sur 3 · L’équipe au meilleur score gagne',
  );
  // The live scene projection carries the chosen language for the overlay scoreboard.
  const latest = scenes.at(-1);
  expect(latest?.language).toBe('fr');
  expect(latest?.instructions?.join(' · ')).toContain('Manche 1 sur 3');
  // Public companion guidance uses the same reviewed rules.
  const view = app.riff.participation.view('de');
  expect(view.interactions[0]?.instructions.join(' · ')).toContain(
    'Best of 3 · jede Runde beginnt von vorn',
  );
});
