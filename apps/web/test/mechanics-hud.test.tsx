// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionHud, sameDefinition } from '../src/sessions/presentation.js';
import { overlaySessionSchema } from '../src/sessions/schemas.js';
import { mechanicsLines } from '../src/sessions/mechanics-hud.js';
import { presetApplies } from '../src/console/rehearsal/labels.js';
import type { ExperienceDefinition, SessionSnapshot, SessionStanding } from '../src/lib/types.js';

afterEach(() => document.body.replaceChildren());

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
    milestones: [{ id: 'fire', label: 'Fire', score: 3, unlock: { command: '!fire', points: 2 } }],
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
    b: { teamId: 'blue', remaining: 5, contributions: 0 },
  },
  scores: { red: 3, blue: 0 },
  winner: null,
  outcome: null,
  mechanics: {
    round: 2,
    wins: { red: 1, blue: 0 },
    history: [{ round: 1, winner: 'red', outcome: 'elimination', scores: { red: 10, blue: 2 } }],
    standings: {
      red: standing({ contributions: 3, unlocked: ['fire'] }),
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

describe('version 2 session HUD', () => {
  it('shows round, health meters, a burst meter with countdown and unlocked tiers accessibly', () => {
    const hud = createSessionHud(siege, running, { now: 21_000 });
    document.body.append(hud);
    expect(hud.textContent).toContain('Round 2 of 3');
    expect(hud.textContent).toContain('wins: Red 1 · Blue 0');
    const meters = [...hud.querySelectorAll('[role="meter"]')];
    const blueHealth = meters.find((m) => m.getAttribute('aria-label') === 'Blue Health');
    expect(blueHealth?.getAttribute('aria-valuenow')).toBe('20');
    expect(blueHealth?.getAttribute('aria-valuemax')).toBe('100');
    const burst = meters.find((m) => m.getAttribute('aria-label') === 'Blue Shield progress');
    expect(burst?.getAttribute('aria-valuetext')).toBe(
      'Blue Shield: 2 / 5 different viewers · window 1 s',
    );
    expect(hud.textContent).toContain('Unlocked · Fire at 3 · !fire');
    expect(hud.textContent).toContain('Locked · Fire at 3');
    expect(hud.textContent).toContain('Last team standing wins.');
    expect(hud.textContent).toContain('5 different viewers using !shield within 10 s');
  });
  it('counts down the intermission and the shield, then announces the match winner', () => {
    const intermission = createSessionHud(
      siege,
      { ...running, deadlineAt: 125_000, remainingMs: 65_000, updatedAt: 60_000 },
      { now: 62_000 },
    );
    expect(intermission.querySelector('[role="status"]')?.textContent).toBe(
      'Next round starts in 3 s',
    );
    const shielded = structuredClone(running);
    shielded.mechanics!.standings.red!.shieldUntil = 25_000;
    expect(createSessionHud(siege, shielded, { now: 21_000 }).textContent).toContain(
      'Shield up · 4 s left',
    );
    const done = createSessionHud(siege, {
      ...running,
      phase: 'finished',
      deadlineAt: null,
      remainingMs: 0,
      winner: 'red',
      outcome: 'elimination',
      mechanics: { ...running.mechanics!, wins: { red: 2, blue: 0 } },
    });
    expect(done.textContent).toContain('Match over · Red wins 2–0!');
  });
  it('compact stream lines and preset filtering follow the exact definition', () => {
    expect(mechanicsLines(siege, running, 21_000)).toEqual([
      'Round 2/3',
      'Red: 100/100 hp · Shield 0/5 · tier 1',
      'Blue: 20/100 hp · Shield 2/5 · tier 0',
    ]);
    expect(presetApplies('elimination', siege)).toBe(true);
    const plain = { ...siege, version: 1 as const };
    delete plain.mechanics;
    expect(presetApplies('elimination', plain)).toBe(false);
    expect(presetApplies('proof', plain)).toBe(true);
    expect(sameDefinition(siege, plain)).toBe(false);
    expect(sameDefinition(siege, structuredClone(siege))).toBe(true);
  });
  it('validates version 2 overlay payloads and rejects mechanics on version 1', () => {
    const payload = { automationId: 'a', title: 't', definition: siege, snapshot: running };
    expect(overlaySessionSchema.safeParse(payload).success).toBe(true);
    const forged = structuredClone(payload);
    forged.snapshot.mechanics!.standings.blue!.health = 500;
    expect(overlaySessionSchema.safeParse(forged).success).toBe(false);
    const v1 = structuredClone(payload) as unknown as { definition: Record<string, unknown> };
    v1.definition.version = 1;
    delete v1.definition.mechanics;
    expect(overlaySessionSchema.safeParse(v1).success).toBe(false);
  });
});
