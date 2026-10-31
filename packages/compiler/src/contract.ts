import { z } from 'zod';
import {
  AUDIENCE_ROLES,
  CAPABILITIES,
  DECISION_CODES,
  PROJECTILE_ASSETS,
  SDK_VERSION,
  SESSION_LIMITS,
  TRIGGER_LIMITS,
} from '@riff/sdk';

/** What the creator asked for. `base` is the version being edited, if any. */
export const compileRequestSchema = z
  .object({
    intent: z.string().trim().min(8).max(1200),
    base: z
      .object({
        title: z.string().max(80),
        intent: z.string().max(1200),
        source: z.string().max(16_384),
        manifest: z.unknown(),
        tests: z.unknown(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type CompileRequest = z.infer<typeof compileRequestSchema>;

const behaviorSchema = z
  .object({
    when: z.string().max(200),
    what: z.string().max(200),
    who: z.string().max(200),
    howMuch: z.string().max(200),
  })
  .strict();

/**
 * Structured compiler output. Executable content is only ever read from these fields,
 * never extracted from free text. Strict validation of manifest and tests is the
 * sandbox verification pipeline's job; here we bound shape and size.
 */
export const compileOutputSchema = z
  .object({
    kind: z.enum(['candidate', 'question', 'unsupported']),
    title: z.string().min(1).max(80),
    summary: z.string().max(400),
    question: z.string().max(400).nullable(),
    choices: z.array(z.string().max(120)).max(4),
    unsupportedReason: z.string().max(400).nullable(),
    alternative: z.string().max(400).nullable(),
    source: z.string().max(16_384).nullable(),
    migrationSource: z.string().min(1).max(32768).nullable().optional(),
    manifest: z.unknown(),
    tests: z.array(z.unknown()).max(12),
    behavior: behaviorSchema,
    assumptions: z.array(z.string().max(240)).max(8),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'candidate' && (!value.source || !value.manifest))
      ctx.addIssue({ code: 'custom', message: 'A candidate needs source and manifest' });
    if (value.kind === 'question' && !value.question)
      ctx.addIssue({ code: 'custom', message: 'A question needs question text' });
    if (value.kind === 'unsupported' && !value.unsupportedReason)
      ctx.addIssue({ code: 'custom', message: 'Unsupported output needs a reason' });
  });
export type CompileOutput = z.infer<typeof compileOutputSchema>;

const nullableString = (maxLength: number) => ({ type: ['string', 'null'], maxLength });
const stringArray = (maxItems: number) => ({ type: 'array', items: { type: 'string' }, maxItems });

/** Strict JSON Schema handed to Codex as the turn's output schema. */
export const COMPILE_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'title',
    'summary',
    'question',
    'choices',
    'unsupportedReason',
    'alternative',
    'source',
    'migrationSource',
    'manifest',
    'tests',
    'behavior',
    'assumptions',
  ],
  properties: {
    kind: { type: 'string', enum: ['candidate', 'question', 'unsupported'] },
    title: { type: 'string', maxLength: 80 },
    summary: { type: 'string', maxLength: 400 },
    question: nullableString(400),
    choices: stringArray(4),
    unsupportedReason: nullableString(400),
    alternative: nullableString(400),
    source: nullableString(16_384),
    migrationSource: nullableString(32768),
    manifest: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['sdkVersion', 'capabilities', 'trigger', 'limits', 'experience'],
          properties: {
            sdkVersion: { type: 'string', enum: [SDK_VERSION] },
            experience: {
              anyOf: [
                { type: 'null' },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: [
                    'version',
                    'title',
                    'durationMs',
                    'maxParticipants',
                    'teams',
                    'resource',
                    'contribution',
                    'objective',
                  ],
                  properties: {
                    version: { type: 'integer', enum: [1] },
                    title: { type: 'string', minLength: 1, maxLength: SESSION_LIMITS.titleLength },
                    durationMs: {
                      type: 'integer',
                      minimum: SESSION_LIMITS.durationMs.min,
                      maximum: SESSION_LIMITS.durationMs.max,
                    },
                    maxParticipants: {
                      type: 'integer',
                      minimum: 1,
                      maximum: SESSION_LIMITS.maxParticipants,
                    },
                    teams: {
                      type: 'array',
                      maxItems: SESSION_LIMITS.maxTeams,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['id', 'label', 'joinCommand'],
                        properties: {
                          id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' },
                          label: {
                            type: 'string',
                            minLength: 1,
                            maxLength: SESSION_LIMITS.labelLength,
                          },
                          joinCommand: { type: 'string', pattern: TRIGGER_LIMITS.commandPattern },
                        },
                      },
                    },
                    resource: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['name', 'perParticipant'],
                      properties: {
                        name: {
                          type: 'string',
                          minLength: 1,
                          maxLength: SESSION_LIMITS.labelLength,
                        },
                        perParticipant: {
                          type: 'integer',
                          minimum: 1,
                          maximum: SESSION_LIMITS.resourcePerParticipant,
                        },
                      },
                    },
                    contribution: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['command', 'points'],
                      properties: {
                        command: { type: 'string', pattern: TRIGGER_LIMITS.commandPattern },
                        points: {
                          type: 'integer',
                          minimum: 1,
                          maximum: SESSION_LIMITS.pointsPerContribution,
                        },
                      },
                    },
                    objective: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['kind', 'target'],
                      properties: {
                        kind: { type: 'string', enum: ['highest-score', 'collective-goal'] },
                        target: {
                          type: ['integer', 'null'],
                          minimum: 1,
                          maximum: SESSION_LIMITS.maxScore,
                        },
                      },
                    },
                  },
                },
              ],
            },
            capabilities: { type: 'array', items: { type: 'string', enum: [...CAPABILITIES] } },
            trigger: {
              type: 'object',
              additionalProperties: false,
              required: ['command', 'audience', 'maxPerViewer', 'windowMs'],
              properties: {
                command: { type: 'string' },
                audience: { type: 'array', items: { type: 'string', enum: [...AUDIENCE_ROLES] } },
                maxPerViewer: { type: 'integer' },
                windowMs: { type: 'integer' },
              },
            },
            limits: {
              type: 'object',
              additionalProperties: false,
              required: ['effectsPerEvent', 'effectsPerMinute'],
              properties: {
                effectsPerEvent: { type: 'integer' },
                effectsPerMinute: { type: 'integer' },
              },
            },
          },
        },
      ],
    },
    tests: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'kind', 'steps'],
        properties: {
          name: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['happy', 'limit', 'role', 'negative', 'duplicate', 'window'],
          },
          steps: {
            type: 'array',
            maxItems: 24,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'viewer', 'roles', 'text', 'at', 'expect', 'effects', 'session'],
              properties: {
                id: { type: 'string' },
                viewer: { type: 'string' },
                roles: { type: 'array', items: { type: 'string', enum: [...AUDIENCE_ROLES] } },
                text: { type: 'string' },
                at: { type: 'integer' },
                expect: { type: 'string', enum: [...DECISION_CODES] },
                effects: { type: 'integer' },
                session: {
                  anyOf: [
                    { type: 'null' },
                    {
                      type: 'object',
                      additionalProperties: false,
                      required: ['phase'],
                      properties: {
                        phase: { type: 'string', enum: ['running', 'paused', 'finished'] },
                      },
                    },
                    {
                      type: 'object',
                      additionalProperties: false,
                      required: ['phase', 'remainingMs'],
                      properties: {
                        phase: { type: 'string', enum: ['running', 'paused', 'finished'] },
                        remainingMs: { type: 'integer', minimum: 0 },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    behavior: {
      type: 'object',
      additionalProperties: false,
      required: ['when', 'what', 'who', 'howMuch'],
      properties: {
        when: { type: 'string' },
        what: { type: 'string' },
        who: { type: 'string' },
        howMuch: { type: 'string' },
      },
    },
    assumptions: stringArray(8),
  },
} as const;

export const ASSETS = PROJECTILE_ASSETS;
