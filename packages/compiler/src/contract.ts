import { z } from 'zod';
import {
  AUDIENCE_ROLES,
  CAPABILITIES,
  DECISION_CODES,
  MECHANIC_LIMITS,
  PROJECTILE_ASSETS,
  SDK_VERSION,
  SESSION_LIMITS,
  TRIGGER_LIMITS,
  TRIGGER_KINDS,
} from '@riff/sdk';

/** Bounded quoted host evidence; never merged into creator-intent extraction. */
const rehearsalContextSchema = z
  .object({
    version: z.literal(1),
    regressions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            originVersionId: z.string().min(1).max(100),
            scenarioHash: z.string().regex(/^[a-f0-9]{64}$/),
            checkId: z.string().min(1).max(100),
            expected: z.union([z.string().max(240), z.number(), z.null()]),
            actual: z.union([z.string().max(240), z.number(), z.null()]),
            summary: z.string().max(240),
            scenario: z.string().max(8192),
          })
          .strict(),
      )
      .max(10),
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 96 * 1024,
    'Rehearsal evidence exceeds its byte limit',
  );

/** What the creator asked for. `base` is the version being edited, if any. */
export const compileRequestSchema = z
  .object({
    intent: z.string().trim().min(8).max(1200),
    rehearsalContext: rehearsalContextSchema.optional(),
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
 * Strict model output must send `mechanics: null` for version 1 definitions; the canonical
 * definition omits the key so version 1 hashes and artifact identities stay unchanged.
 */
function withoutNullMechanics(manifest: unknown): unknown {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return manifest;
  const experience = (manifest as { experience?: unknown }).experience;
  if (
    !experience ||
    typeof experience !== 'object' ||
    Array.isArray(experience) ||
    !Object.hasOwn(experience, 'mechanics') ||
    (experience as { mechanics?: unknown }).mechanics !== null
  )
    return manifest;
  const rest = Object.fromEntries(
    Object.entries(experience as Record<string, unknown>).filter(([key]) => key !== 'mechanics'),
  );
  return { ...manifest, experience: rest };
}

const int = (range: { min: number; max: number }) => ({
  type: 'integer',
  minimum: range.min,
  maximum: range.max,
});
const command = { type: 'string', pattern: TRIGGER_LIMITS.commandPattern } as const;
const label = { type: 'string', minLength: 1, maxLength: SESSION_LIMITS.labelLength } as const;
const strictObject = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [{ type: 'null' }, schema] });
/** Definition version 2 mechanics for the strict model schema; host zod rules stay authoritative. */
const MECHANICS_JSON_SCHEMA = nullable(
  strictObject({
    match: nullable(
      strictObject({
        rounds: int(MECHANIC_LIMITS.rounds),
        intermissionMs: int(MECHANIC_LIMITS.intermissionMs),
      }),
    ),
    health: nullable(
      strictObject({
        label,
        max: int(MECHANIC_LIMITS.health),
        damage: int(MECHANIC_LIMITS.damage),
        heal: nullable(strictObject({ command, amount: int(MECHANIC_LIMITS.heal) })),
      }),
    ),
    burst: nullable(
      strictObject({
        command: { type: ['string', 'null'], pattern: TRIGGER_LIMITS.commandPattern },
        label,
        participants: int(MECHANIC_LIMITS.burstParticipants),
        windowMs: int(MECHANIC_LIMITS.burstWindowMs),
        points: int(MECHANIC_LIMITS.burstPoints),
        limit: int(MECHANIC_LIMITS.burstLimit),
        shieldMs: int(MECHANIC_LIMITS.shieldMs),
      }),
    ),
    milestones: {
      type: 'array',
      maxItems: MECHANIC_LIMITS.milestones,
      items: strictObject({
        id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' },
        label,
        score: { type: 'integer', minimum: 1, maximum: SESSION_LIMITS.maxScore },
        unlock: nullable(strictObject({ command, points: int(MECHANIC_LIMITS.unlockPoints) })),
      }),
    },
  }),
);

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
    manifest: z.unknown().transform(withoutNullMechanics),
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
                    'mechanics',
                  ],
                  properties: {
                    version: { type: 'integer', enum: [1, 2] },
                    mechanics: MECHANICS_JSON_SCHEMA,
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
                        kind: {
                          type: 'string',
                          enum: ['highest-score', 'collective-goal', 'burst'],
                        },
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
              required: ['command', 'audience', 'maxPerViewer', 'windowMs', 'kind', 'reward'],
              properties: {
                command: { type: 'string' },
                audience: { type: 'array', items: { type: 'string', enum: [...AUDIENCE_ROLES] } },
                maxPerViewer: { type: 'integer' },
                windowMs: { type: 'integer' },
                kind: { type: 'string', enum: [...TRIGGER_KINDS] },
                reward: { type: ['string', 'null'], maxLength: 45 },
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
              required: [
                'id',
                'viewer',
                'roles',
                'text',
                'at',
                'expect',
                'effects',
                'session',
                'timers',
                'kind',
              ],
              properties: {
                id: { type: 'string' },
                viewer: { type: 'string' },
                roles: { type: 'array', items: { type: 'string', enum: [...AUDIENCE_ROLES] } },
                text: { type: 'string' },
                at: { type: 'integer' },
                expect: { type: 'string', enum: [...DECISION_CODES] },
                effects: { type: 'integer' },
                timers: {
                  anyOf: [
                    { type: 'null' },
                    {
                      type: 'object',
                      additionalProperties: false,
                      required: ['fired', 'effects'],
                      properties: {
                        fired: { type: 'integer', minimum: 0 },
                        effects: { type: 'integer', minimum: 0 },
                      },
                    },
                  ],
                },
                kind: { type: ['string', 'null'], enum: ['points.redeem', null] },
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
