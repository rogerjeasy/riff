import { describe, expect, it } from 'vitest';
// Mirrors FORMAT_LIMITS in packages/sdk/src/index.ts (web cannot import packages).
const FORMAT_LIMITS = { promptLength: 140, explanationLength: 200 } as const;
import { overlayMessageSchema } from '../src/overlay/messages.js';

// Recorded from production (2026-11-02): a real Codex quiz whose explanations exceed 60
// characters. The overlay schema capped every text field at 60, rejected the whole
// sessions message and cleared the overlay, instructions included.
const quiz = {
  automationId: 'a-quiz',
  versionId: 'v-quiz',
  title: 'Solar System Quiz',
  definition: {
    version: 3,
    title: 'Solar System Quiz',
    durationMs: 120000,
    maxParticipants: 256,
    teams: [],
    resource: {
      name: 'answers',
      perParticipant: 3,
    },
    contribution: {
      command: '!a',
      points: 1,
    },
    objective: {
      kind: 'highest-score',
      target: null,
    },
    format: {
      kind: 'quiz',
      passPercent: 60,
      revealMs: 10000,
      questions: [
        {
          prompt: 'Which planet is the largest in our solar system?',
          options: ['Jupiter', 'Saturn', 'Earth'],
          answer: 0,
          explanation:
            'Jupiter is the largest planet in our solar system, about 11 times wider than Earth.',
        },
        {
          prompt: 'Which planet is closest to the Sun?',
          options: ['Venus', 'Mercury', 'Mars'],
          answer: 1,
          explanation: 'Mercury has the closest orbit to the Sun.',
        },
        {
          prompt: 'Which planet is known as the Red Planet?',
          options: ['Jupiter', 'Venus', 'Mars'],
          answer: 2,
          explanation:
            'Iron oxide, or rust, in the surface material gives Mars its reddish appearance.',
        },
      ],
    },
  },
  snapshot: {
    id: 's-quiz',
    phase: 'running',
    startedAt: 1793645802162,
    deadlineAt: 1793645922162,
    remainingMs: 93233,
    updatedAt: 1793645828929,
    revision: 4,
    participants: {
      'viewer-1': {
        teamId: null,
        remaining: 2,
        contributions: 1,
      },
    },
    scores: {
      community: 1,
    },
    winner: null,
    outcome: null,
    format: {
      canvas: [],
      choices: {
        'viewer-1': [0, -1, -1],
      },
    },
  },
};

describe('overlay accepts the SDK format text limits (production regression)', () => {
  it('accepts a real quiz session with long explanations', () => {
    const parsed = overlayMessageSchema.safeParse({
      v: 1,
      type: 'sessions',
      payload: { sessions: [quiz] },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
  it('allows prompts and explanations up to the SDK limits, and no further', () => {
    const at = (prompt: number, explanation: number) => {
      const copy = structuredClone(quiz);
      const q = copy.definition.format.questions[0]!;
      q.prompt = 'p'.repeat(prompt);
      q.explanation = 'e'.repeat(explanation);
      return overlayMessageSchema.safeParse({
        v: 1,
        type: 'sessions',
        payload: { sessions: [copy] },
      }).success;
    };
    expect(at(FORMAT_LIMITS.promptLength, FORMAT_LIMITS.explanationLength)).toBe(true);
    expect(at(FORMAT_LIMITS.promptLength + 1, 10)).toBe(false);
    expect(at(10, FORMAT_LIMITS.explanationLength + 1)).toBe(false);
  });
});
