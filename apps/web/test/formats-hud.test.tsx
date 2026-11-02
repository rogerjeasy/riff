// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionHud } from '../src/sessions/presentation.js';
import { formatLines, formatOutcome, formatSlot } from '../src/sessions/formats-hud.js';
import { FORMAT_REASONS, SESSION_COPY, SESSION_LANGUAGES } from '../src/sessions/mechanics-copy.js';
import { overlaySessionSchema } from '../src/sessions/schemas.js';
import type { ExperienceDefinition, SessionSnapshot } from '../src/lib/types.js';

/*
 * F31 version 3 formats: the shared HUD presents a mural grid, a staged composition card
 * and a quiz with reveal, using reviewed en/fr/es/de copy and safe text only.
 */

afterEach(() => document.body.replaceChildren());

const base = {
  version: 3 as const,
  maxParticipants: 64,
  teams: [],
  objective: { kind: 'highest-score' as const, target: null },
};
const mural: ExperienceDefinition = {
  ...base,
  title: 'Pixel Mural',
  durationMs: 120_000,
  resource: { name: 'paints', perParticipant: 3 },
  contribution: { command: '!paint', points: 1 },
  format: {
    kind: 'mural',
    width: 2,
    height: 2,
    palette: ['red', 'blue'],
    overwrite: false,
    reveal: 'live',
  },
};
const song: ExperienceDefinition = {
  ...base,
  title: 'Song Stages',
  durationMs: 120_000,
  resource: { name: 'votes', perParticipant: 2 },
  contribution: { command: '!vote', points: 1 },
  format: {
    kind: 'composition',
    tieBreak: 'first-listed',
    stages: [
      {
        id: 'tempo',
        label: 'Tempo',
        options: [
          { id: 'slow', label: 'Slow' },
          { id: 'fast', label: 'Fast' },
        ],
      },
      {
        id: 'mood',
        label: 'Mood',
        options: [
          { id: 'happy', label: 'Happy' },
          { id: 'dreamy', label: 'Dreamy' },
        ],
      },
    ],
  },
};
const quiz: ExperienceDefinition = {
  ...base,
  title: 'Solar Quiz',
  durationMs: 60_000,
  resource: { name: 'answers', perParticipant: 2 },
  contribution: { command: '!a', points: 1 },
  format: {
    kind: 'quiz',
    passPercent: 50,
    revealMs: 10_000,
    questions: [
      {
        prompt: 'Which planet is largest?',
        options: ['Jupiter', 'Mars'],
        answer: 0,
        explanation: 'Jupiter is the largest planet.',
      },
      {
        prompt: 'Closest to the Sun?',
        options: ['Earth', 'Mercury'],
        answer: 1,
        explanation: 'Mercury orbits closest.',
      },
    ],
  },
};
const snapshot = (extra: Partial<SessionSnapshot>): SessionSnapshot => ({
  id: 's',
  phase: 'running',
  startedAt: 0,
  deadlineAt: 120_000,
  remainingMs: 120_000,
  updatedAt: 0,
  revision: 1,
  participants: {},
  scores: { community: 0 },
  winner: null,
  outcome: null,
  ...extra,
});

describe('version 3 format copy', () => {
  it('has a reviewed phrase for every format rejection reason in every language', () => {
    for (const language of SESSION_LANGUAGES)
      for (const code of FORMAT_REASONS)
        expect(Object.hasOwn(SESSION_COPY[language], code), `${language}.${code}`).toBe(true);
  });
});

describe('format HUD', () => {
  it('draws the mural as one accessible image and never shows viewer text', () => {
    const s = snapshot({
      participants: { a: { teamId: null, remaining: 2, contributions: 1 } },
      scores: { community: 1 },
      format: { canvas: [0, -1, -1, -1], choices: {} },
    });
    expect(
      overlaySessionSchema.safeParse({
        automationId: 'x',
        title: 'Pixel Mural',
        definition: mural,
        snapshot: s,
      }).success,
    ).toBe(true);
    const hud = createSessionHud(mural, s, { language: 'fr' });
    const grid = hud.querySelector('.session-mural');
    expect(grid?.getAttribute('role')).toBe('img');
    expect(grid?.getAttribute('aria-label')).toBe(
      'Fresque de 2 sur 2\u00a0: 1 cases peintes sur 4',
    );
    expect(hud.querySelectorAll('.session-mural-cell')).toHaveLength(4);
    expect(hud.textContent).toContain('Une case peinte est définitive.');
    expect(hud.textContent).not.toContain('Highest');
    expect(formatLines(mural, s, 0, 'de')).toEqual(['1/4 bemalt']);
  });
  it('hides an end-reveal mural until the session finishes', () => {
    const hidden = { ...mural, format: { ...mural.format!, reveal: 'end' as const } };
    const s = snapshot({ format: { canvas: [0, 1, -1, -1], choices: {} } });
    const hud = createSessionHud(hidden as ExperienceDefinition, s, { language: 'en' });
    expect(hud.querySelector('.session-mural')).toBeNull();
    expect(hud.textContent).toContain('Mural hidden until the reveal');
  });
  it('shows the open stage tally and the composition so far, visually only', () => {
    const s = snapshot({
      remainingMs: 50_000,
      deadlineAt: 50_000 + 70_000,
      updatedAt: 70_000,
      participants: {
        a: { teamId: null, remaining: 0, contributions: 2 },
        b: { teamId: null, remaining: 1, contributions: 1 },
      },
      scores: { community: 3 },
      format: {
        canvas: [],
        choices: { a: [1, 1], b: [0, -1] },
      },
    });
    expect(formatSlot(song, s, 70_000).slot).toBe(1);
    const hud = createSessionHud(song, s, { language: 'es', viewerId: 'a', now: 70_000 });
    expect(hud.textContent).toContain('Etapa 2 de 2: Mood');
    expect(hud.textContent).toContain('2. Dreamy · 1 voto');
    // Tempo tied 1–1: the declared first-listed tie-break picks Slow.
    expect(hud.textContent).toContain('Tempo: Slow');
    expect(hud.textContent).toContain('Mood: votando…');
    expect(hud.querySelector('.session-viewer-status')?.textContent).toContain(
      'Ya elegiste en esta etapa',
    );
    const done = {
      ...s,
      phase: 'finished' as const,
      deadlineAt: null,
      remainingMs: 0,
      outcome: 'deadline' as const,
      winner: 'community',
    };
    expect(formatOutcome(song, done, 'en')).toBe('Tempo: Slow · Mood: Dreamy');
  });
  it('reveals the answer, explanation and collective result without ranking viewers', () => {
    const s = snapshot({
      deadlineAt: 60_000,
      remainingMs: 35_000,
      updatedAt: 25_000,
      participants: {
        a: { teamId: null, remaining: 1, contributions: 1 },
        b: { teamId: null, remaining: 1, contributions: 1 },
      },
      scores: { community: 2 },
      format: { canvas: [], choices: { a: [0, -1], b: [1, -1] } },
    });
    const hud = createSessionHud(quiz, s, { language: 'de', now: 25_000 });
    expect(hud.querySelector('.session-quiz-prompt')?.textContent).toBe('Which planet is largest?');
    expect(hud.querySelector('[data-correct="true"]')?.textContent).toContain('!a Jupiter');
    expect(hud.querySelector('.session-quiz-reveal')?.getAttribute('role')).toBe('status');
    expect(hud.textContent).toContain('Gemeinsam gelöst · 50 % richtig');
    expect(hud.textContent).toContain('Jupiter is the largest planet.');
    expect(hud.textContent).toContain('Gemeinsam gelöst: 1 von 2');
    expect(hud.textContent).not.toMatch(/\b[ab]\b:/);
  });
});
