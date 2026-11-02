// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionHud } from '../src/sessions/presentation.js';
import { mechanicsLines, mechanicsOutcome } from '../src/sessions/mechanics-hud.js';
import {
  MECHANICS_REASONS,
  SESSION_COPY,
  SESSION_LANGUAGES,
  mechanicsReason,
  sessionText,
} from '../src/sessions/mechanics-copy.js';
import { renderScene, roundStatus } from '../src/scenes/render.js';
import { defaultScene, sceneProjectionSchema } from '../src/scenes/schema.js';
import { guidanceSchema } from '../src/participation/contracts.js';
import type { ExperienceDefinition, SessionSnapshot, SessionStanding } from '../src/lib/types.js';

/*
 * F40: version 2 HUD and scoreboard copy is reviewed per language, complete, and selected
 * by the host-provided language; accessible names and reasons are translated too.
 */

afterEach(() => document.body.replaceChildren());

const placeholders = (phrase: string | { one: string; other: string }) =>
  [
    ...new Set(
      (typeof phrase === 'string' ? phrase : `${phrase.one} ${phrase.other}`).match(/\{\w+\}/g),
    ),
  ].sort();

const standing = (extra: Partial<SessionStanding> = {}): SessionStanding => ({
  health: 100,
  eliminated: false,
  contributions: 0,
  heals: 0,
  unlocks: {},
  bursts: 0,
  burstWindow: [],
  shieldUntil: null,
  unlocked: [],
  ...extra,
});
const siege: ExperienceDefinition = {
  version: 2,
  title: 'Castle Siege',
  durationMs: 60_000,
  maxParticipants: 32,
  teams: [
    { id: 'red', label: 'Red', joinCommand: '!red' },
    { id: 'blue', label: 'Blue', joinCommand: '!blue' },
  ],
  resource: { name: 'attacks', perParticipant: 5 },
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
const running: SessionSnapshot = {
  id: 's',
  phase: 'running',
  startedAt: 0,
  deadlineAt: 60_000,
  remainingMs: 40_000,
  updatedAt: 20_000,
  revision: 9,
  participants: {
    a: { teamId: 'red', remaining: 2, contributions: 3 },
    b: { teamId: 'blue', remaining: 5, contributions: 1 },
  },
  scores: { red: 3, blue: 0 },
  winner: null,
  outcome: null,
  mechanics: {
    round: 2,
    wins: { red: 1, blue: 0 },
    history: [{ round: 1, winner: 'red', outcome: 'elimination', scores: { red: 10, blue: 2 } }],
    standings: {
      red: standing({ contributions: 3 }),
      blue: standing({
        health: 20,
        burstWindow: [
          { viewerId: 'b', at: 12_000 },
          { viewerId: 'c', at: 19_000 },
        ],
      }),
    },
  },
};

describe('reviewed session copy', () => {
  it('has every key in every language with identical placeholders and plural shape', () => {
    const keys = Object.keys(SESSION_COPY.en).sort();
    for (const language of SESSION_LANGUAGES) {
      const copy = SESSION_COPY[language] as unknown as Record<string, unknown>;
      expect(Object.keys(copy).sort()).toEqual(keys);
      for (const key of keys) {
        if (key === 'locale') continue;
        const en = (
          SESSION_COPY.en as unknown as Record<string, string | { one: string; other: string }>
        )[key]!;
        const phrase = copy[key] as string | { one: string; other: string };
        expect(typeof phrase, `${language}.${key}`).toBe(typeof en);
        expect(placeholders(phrase), `${language}.${key}`).toEqual(placeholders(en));
      }
    }
    // Every viewer-facing rejection reason has a reviewed phrase.
    for (const code of MECHANICS_REASONS) expect(Object.hasOwn(SESSION_COPY.en, code)).toBe(true);
  });

  it('renders the version 2 HUD in French, Spanish and German with translated accessible names', () => {
    const expected = {
      fr: {
        round: 'Manche 2 sur 3 · au meilleur des 3 · victoires : Red 1 · Blue 0',
        health: 'Health de Blue',
        burst: 'Progression de Shield pour Blue',
        burstText: 'Shield pour Blue : 2 / 5 spectateurs différents · fenêtre : 1 s',
        tiers: 'Paliers de Red',
        tier: 'Verrouillé · Boost à 20 · !boost',
        rule: '5 spectateurs différents qui utilisent !shield en 10 s déclenchent Shield, qui bloque les dégâts pendant 8 s.',
        objective: 'La dernière équipe en lice gagne.',
        phase: 'En cours',
      },
      es: {
        round: 'Ronda 2 de 3 · al mejor de 3 · victorias: Red 1 · Blue 0',
        health: 'Health de Blue',
        burst: 'Progreso de Shield de Blue',
        burstText: 'Shield de Blue: 2 / 5 espectadores distintos · ventana: 1 s',
        tiers: 'Hitos de Red',
        tier: 'Bloqueado · Boost con 20 · !boost',
        rule: '5 espectadores distintos que usen !shield en 10 s activan Shield, que bloquea el daño durante 8 s.',
        objective: 'Gana el último equipo en pie.',
        phase: 'En juego',
      },
      de: {
        round: 'Runde 2 von 3 · Best of 3 · Siege: Red 1 · Blue 0',
        health: 'Blue: Health',
        burst: 'Blue: Fortschritt Shield',
        burstText: 'Blue: Shield 2 / 5 verschiedene Zuschauer · Fenster: 1 s',
        tiers: 'Meilensteine von Red',
        tier: 'Gesperrt · Boost ab 20 · !boost',
        rule: '5 verschiedene Zuschauer, die innerhalb von 10 s !shield nutzen, lösen Shield aus, das 8 s lang Schaden blockt.',
        objective: 'Das letzte verbleibende Team gewinnt.',
        phase: 'Läuft',
      },
    } as const;
    for (const language of ['fr', 'es', 'de'] as const) {
      const want = expected[language];
      const hud = createSessionHud(siege, running, { now: 21_000, language });
      document.body.append(hud);
      expect(hud.lang).toBe(language);
      expect(hud.querySelector('.session-round')?.textContent).toBe(want.round);
      expect(hud.querySelector('.session-phase')?.textContent).toContain(want.phase);
      const meters = [...hud.querySelectorAll('[role="meter"]')];
      const health = meters.find((m) => m.getAttribute('aria-label') === want.health);
      expect(health?.getAttribute('aria-valuenow')).toBe('20');
      const burst = meters.find((m) => m.getAttribute('aria-label') === want.burst);
      expect(burst?.getAttribute('aria-valuetext')).toBe(want.burstText);
      expect(hud.querySelector('.session-tiers')?.getAttribute('aria-label')).toBe(want.tiers);
      expect(hud.textContent).toContain(want.tier);
      expect(hud.textContent).toContain(want.rule);
      expect(hud.textContent).toContain(want.objective);
      // No English rule text leaks into a translated HUD.
      expect(hud.textContent).not.toMatch(/different viewers|Last team standing|Round 2 of 3/);
      hud.remove();
    }
  });

  it('shows elimination as its own outcome and match results in each language', () => {
    const single = structuredClone(siege);
    single.mechanics!.match = null;
    const finished: SessionSnapshot = {
      ...running,
      phase: 'finished',
      deadlineAt: null,
      remainingMs: 0,
      winner: 'red',
      outcome: 'elimination',
    };
    expect(mechanicsOutcome(single, finished, 'en')).toBe('Last team standing · Red wins!');
    expect(mechanicsOutcome(single, finished, 'fr')).toBe('Dernière équipe en lice · Red gagne !');
    expect(mechanicsOutcome(single, finished, 'es')).toBe('Último equipo en pie · ¡Gana Red!');
    expect(mechanicsOutcome(single, finished, 'de')).toBe('Letztes Team im Spiel · Red gewinnt!');
    const match = { ...finished, mechanics: { ...running.mechanics!, wins: { red: 2, blue: 0 } } };
    expect(mechanicsOutcome(siege, match, 'de')).toBe('Match vorbei · Red gewinnt 2–0!');
  });

  it('translates compact stream lines and the scene scoreboard from the projection language', () => {
    expect(mechanicsLines(siege, running, 21_000, 'de')).toEqual([
      'Runde 2/3',
      'Red: 100/100 LP · Shield 0/5 · Stufe 0',
      'Blue: 20/100 LP · Shield 2/5 · Stufe 0',
    ]);
    expect(mechanicsLines(siege, running, 21_000, 'fr')[0]).toBe('Manche 2/3');
    expect(roundStatus(running, 0, 'es')).toBe('quedan 1:00');
    expect(roundStatus({ ...running, phase: 'finished' }, 0, 'fr')).toBe('Manche terminée');
    const root = document.createElement('div');
    document.body.append(root);
    renderScene(root, defaultScene(), {
      now: 21_000,
      definition: siege,
      snapshot: running,
      language: 'es',
    });
    const board = root.querySelector('[data-scene-kind="scoreboard"]')?.textContent ?? '';
    expect(board).toContain('Ronda 2/3');
    expect(board).not.toContain('Round 2/3');
    // Projections carry the host-selected language; unknown values are rejected.
    const projection = {
      automationId: 'a',
      versionId: 'v',
      revision: 0,
      digest: 'a'.repeat(64),
      scene: defaultScene(),
      language: 'de',
      instructions: ['1', '2', '3', '4', '5', '6'],
    };
    expect(sceneProjectionSchema.safeParse(projection).success).toBe(true);
    expect(sceneProjectionSchema.safeParse({ ...projection, language: 'xx' }).success).toBe(false);
    expect(
      guidanceSchema.shape.interactions.element.shape.instructions.safeParse([
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
      ]).success,
    ).toBe(true);
  });

  it('localizes every viewer-facing rejection reason and shows the applicable ones to a viewer', () => {
    for (const language of SESSION_LANGUAGES)
      for (const code of MECHANICS_REASONS) {
        const text = mechanicsReason(language, code, {
          label: 'Shield',
          command: '!boost',
          score: 20,
        });
        expect(text, `${language}.${code}`).not.toMatch(/\{\w+\}/);
        if (language !== 'en')
          expect(text, `${language}.${code}`).not.toBe(
            mechanicsReason('en', code, { label: 'Shield', command: '!boost', score: 20 }),
          );
      }
    expect(mechanicsReason('fr', 'LOCKED', { command: '!boost', score: 20 })).toBe(
      '!boost se débloque à 20 points',
    );
    expect(mechanicsReason('de', 'ROUND_INTERMISSION')).toBe(
      'Zwischen den Runden: Warte auf die nächste Runde',
    );
    // Viewer b already counts toward Blue's shield window; Red's health is full for a heal.
    const hud = createSessionHud(siege, running, { now: 21_000, viewerId: 'b', language: 'es' });
    const status = hud.querySelector('[role="status"].session-viewer-status');
    expect(status?.getAttribute('aria-label')).toBe('Por qué se pueden ignorar comandos');
    expect(status?.textContent).toContain('Ya cuentas para Shield');
    expect(status?.textContent).toContain('!boost se desbloquea al llegar a 20 puntos');
    const red = createSessionHud(siege, running, { now: 21_000, viewerId: 'a', language: 'de' });
    expect(red.textContent).toContain('Health ist bereits voll');
    const out = structuredClone(running);
    out.mechanics!.standings.blue!.eliminated = true;
    expect(
      createSessionHud(siege, out, { now: 21_000, viewerId: 'b', language: 'fr' }).textContent,
    ).toContain('Votre équipe est éliminée pour cette manche');
    const between = createSessionHud(
      siege,
      { ...running, deadlineAt: 125_000, remainingMs: 65_000, updatedAt: 60_000 },
      { now: 62_000, viewerId: 'a', language: 'en' },
    );
    expect(between.textContent).toContain('Between rounds: wait for the next round');
  });

  it('keeps broadcast reduced motion on the HUD and plural forms per locale', () => {
    const hud = createSessionHud(siege, running, { now: 21_000, reducedMotion: true });
    expect(hud.dataset.reducedMotion).toBe('true');
    expect(sessionText('fr', 'goalRule', { target: 1 }, 1)).toBe('Atteignez ensemble 1 point.');
    expect(sessionText('de', 'goalRule', { target: 40 }, 40)).toBe('Erreicht gemeinsam 40 Punkte.');
    expect(sessionText('es', 'burstGoalRule', { label: 'Escudo', target: 1 }, 1)).toBe(
      'Activa Escudo una vez para ganar.',
    );
  });
});
