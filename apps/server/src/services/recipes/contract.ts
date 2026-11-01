import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sceneSchema } from '@riff/compiler';
import {
  DEFAULT_SCENE,
  SDK_VERSION,
  TRIGGER_LIMITS,
  AUDIENCE_ROLES,
  type RecipePackage,
  type RecipeProfile,
} from '@riff/sdk';
import { manifestSchema, scenariosSchema } from '@riff/sandbox';
import { findPrivateText } from './secrets.js';

/** Retention and size bounds for one channel's recipe library. */
export const RECIPE_LIMITS = Object.freeze({
  packageBytes: 131_072,
  sourceBytes: 16_384,
  imports: 50,
  exports: 50,
  reviews: 50,
  publications: 50,
  reports: 100,
  openReportsPerEdition: 20,
  reportsPerClientPerHour: 5,
  rateKeys: 100,
  rateWindowMs: 3_600_000,
  deadlineMs: 180_000,
});

export type RecipeErrorCode =
  | 'INVALID'
  | 'STALE'
  | 'BLOCKED'
  | 'BUSY'
  | 'LIMIT'
  | 'RATE'
  | 'NOT_FOUND'
  | 'UNSUPPORTED'
  | 'CONFLICT';
/** Every recipe error carries a user-safe message that says what happened and what to do. */
export class RecipeError extends Error {
  constructor(
    readonly code: RecipeErrorCode,
    message: string,
  ) {
    super(message.slice(0, 240));
  }
}

/** Canonical JSON: sorted keys, and undefined handled exactly as JSON.stringify does. */
export function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? 'null' : canonical(item))).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

/** Path in reader terms: `tests[0].steps[1].text`. */
const pathOf = (path: readonly PropertyKey[]) =>
  path.reduce<string>(
    (text, part) =>
      typeof part === 'number'
        ? `${text}[${part}]`
        : text
          ? `${text}.${String(part)}`
          : String(part),
    '',
  );
/** One zod issue as a plain sentence naming the field. */
export function describeIssue(issue: z.core.$ZodIssue, root = ''): string {
  const field = [root, pathOf(issue.path)].filter(Boolean).join('.') || root || 'The recipe';
  switch (issue.code) {
    case 'invalid_type':
      return issue.message.endsWith('received undefined')
        ? `${field} is missing.`
        : `${field} must be ${issue.expected === 'int' ? 'a whole number' : `a ${issue.expected}`}.`;
    case 'too_big':
      return issue.origin === 'string'
        ? `${field} is too long (at most ${issue.maximum} characters).`
        : issue.origin === 'array'
          ? `${field} has too many entries (at most ${issue.maximum}).`
          : `${field} must be at most ${issue.maximum}.`;
    case 'too_small':
      return issue.origin === 'string'
        ? `${field} is empty or too short.`
        : issue.origin === 'array'
          ? `${field} needs at least ${issue.minimum} entries.`
          : `${field} must be at least ${issue.minimum}.`;
    case 'invalid_value':
      return `${field} must be ${issue.values.map((value) => JSON.stringify(value)).join(' or ')}.`;
    case 'invalid_format':
      return `${field} has an unsupported format.`;
    case 'unrecognized_keys':
      return `${field} has unsupported field${issue.keys.length > 1 ? 's' : ''}: ${issue.keys
        .slice(0, 4)
        .join(', ')}.`;
    default:
      return `${field}: ${issue.message}`;
  }
}
export const describeError = (error: z.ZodError, root = '') =>
  error.issues[0] ? describeIssue(error.issues[0], root) : `${root || 'The recipe'} is invalid.`;

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) => [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
      'Remove control characters.',
    );
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const license = z.enum(['MIT', 'CC0-1.0', 'CC-BY-4.0']);
const unique = <T>(list: T[]) => new Set(list).size === list.length;
export const profileSchema = z
  .object({
    displayName: text(80),
    language: z.enum(['en', 'fr', 'es', 'de']),
    reducedMotion: z.boolean(),
    highContrast: z.boolean().optional(),
    effectLabels: z.boolean().optional(),
    scene: sceneSchema,
    capabilities: z
      .array(z.enum(['overlay', 'session']))
      .min(1)
      .max(2)
      .refine(unique, 'List each capability once.'),
    command: z.string().regex(new RegExp(TRIGGER_LIMITS.commandPattern)),
    audience: z
      .array(z.enum(AUDIENCE_ROLES))
      .min(1)
      .max(4)
      .refine(unique, 'List each audience role once.'),
    maxPerViewer: z.number().int().min(1).max(100),
    windowMs: z.number().int().min(1000).max(3600000),
  })
  .strict();
export const defaultProfile = (): RecipeProfile => ({
  revision: 0,
  displayName: 'My channel',
  language: 'en',
  reducedMotion: false,
  scene: structuredClone(DEFAULT_SCENE),
  capabilities: ['overlay', 'session'],
  command: '!tomato',
  audience: ['viewer'],
  maxPerViewer: 3,
  windowMs: 60000,
});
const packageSchema = z
  .object({
    version: z.literal(1),
    recipeId: text(80),
    revision: z.number().int().min(1).max(1000000),
    digest: hash,
    title: text(80),
    description: text(500),
    author: text(80),
    license,
    rightsAttested: z.literal(true),
    source: z
      .string()
      .min(1)
      .refine(
        (source) => Buffer.byteLength(source, 'utf8') <= RECIPE_LIMITS.sourceBytes,
        `Source must be at most ${RECIPE_LIMITS.sourceBytes / 1024} KiB of UTF-8.`,
      ),
    // Structure only: manifest rules are reported as readable blockers by `blockersFor`.
    manifest: z.record(z.string(), z.unknown()),
    tests: scenariosSchema,
    scene: sceneSchema,
    presentation: z
      .object({
        language: z.enum(['en', 'fr', 'es', 'de']),
        reducedMotion: z.boolean(),
        highContrast: z.boolean().optional(),
        effectLabels: z.boolean().optional(),
      })
      .strict(),
    assets: z
      .array(
        z
          .object({
            id: z.enum(['tomato', 'star', 'heart']),
            credit: z.literal('Riff'),
            license: z.literal('project-license'),
          })
          .strict(),
      )
      .max(3),
    lineage: z
      .array(
        z
          .object({
            recipeId: text(80),
            revision: z.number().int().positive(),
            digest: hash,
            author: text(80),
            license,
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

/** Refuse recognizable credentials and embedded bytes, naming the field that held them. */
export function assertPublic(value: unknown) {
  const problem = findPrivateText(value);
  if (!problem) return;
  throw new RecipeError(
    'INVALID',
    problem.kind === 'credential'
      ? `${problem.field} looks like it contains a secret token or credential. Remove it before sharing.`
      : `${problem.field} embeds encoded data. Use the built-in artwork instead.`,
  );
}
const tooLarge = () =>
  new RecipeError(
    'LIMIT',
    `This recipe is larger than ${RECIPE_LIMITS.packageBytes / 1024} KiB. Choose a smaller export.`,
  );
export function parsePackage(raw: unknown): RecipePackage {
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw) > RECIPE_LIMITS.packageBytes) throw tooLarge();
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new RecipeError(
        'INVALID',
        'This file is not valid recipe JSON. Choose an exported recipe.',
      );
    }
  }
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > RECIPE_LIMITS.packageBytes) throw tooLarge();
  const result = packageSchema.safeParse(raw);
  if (!result.success) throw new RecipeError('INVALID', describeError(result.error));
  const { digest: expected, ...content } = result.data;
  if (digest(content) !== expected)
    throw new RecipeError(
      'INVALID',
      'The recipe integrity digest does not match its content. Download the original export again.',
    );
  if (result.data.lineage.some((credit) => credit.license !== result.data.license))
    throw new RecipeError('INVALID', 'Keep the original source license and all credits.');
  assertPublic(result.data);
  return result.data as unknown as RecipePackage;
}

/** Readable reasons this channel cannot run a package; empty when it is supported. */
export function blockersFor(pack: RecipePackage, capabilities: string[]) {
  const manifest = pack.manifest as unknown as Record<string, unknown>;
  const blockers: string[] = [];
  if (manifest.sdkVersion !== SDK_VERSION && manifest.sdkVersion !== '0.3.0')
    blockers.push(`Unsupported SDK: ${String(manifest.sdkVersion).slice(0, 40)}`);
  if (!Array.isArray(manifest.capabilities)) blockers.push('Missing capability declarations');
  else
    for (const capability of manifest.capabilities)
      if (!capabilities.includes(capability))
        blockers.push(`Unsupported capability: ${String(capability).slice(0, 40)}`);
  const checked = manifestSchema.safeParse(manifest);
  if (!checked.success)
    for (const issue of checked.error.issues) {
      // SDK and capability problems are already listed above in plainer words.
      if (issue.path[0] === 'sdkVersion' || issue.path[0] === 'capabilities') continue;
      blockers.push(describeIssue(issue, 'manifest').replace(/\.$/, ''));
      if (blockers.length >= 6) break;
    }
  return blockers;
}

/** Commands a manifest listens for: its trigger plus any team join commands. */
export const commandsOf = (manifest: RecipePackage['manifest']) => [
  manifest.trigger.command,
  ...(manifest.experience?.teams.map((team) => team.joinCommand) ?? []),
];

/** Export only synthetic test identities and command-shaped inputs; live/private text is never copied. */
export function publicTests(raw: unknown, command: string, joinCommands: string[] = []): unknown {
  const tests = scenariosSchema.safeParse(raw);
  if (!tests.success)
    throw new RecipeError(
      'INVALID',
      `This version's tests cannot be shared: ${describeError(tests.error, 'tests')} Verify it again first.`,
    );
  const identities = new Map<string, string>();
  const identity = (id: string) => {
    let synthetic = identities.get(id);
    if (!synthetic) {
      synthetic = `synthetic_${identities.size + 1}`;
      identities.set(id, synthetic);
    }
    return synthetic;
  };
  const commands = new Set([command, ...joinCommands]);
  return tests.data.map((test, index) => ({
    name: `Synthetic ${test.kind} ${index + 1}`,
    kind: test.kind,
    steps: test.steps.map((step) => ({
      ...step,
      id: identity(step.id),
      viewer: identity(step.viewer),
      text: commands.has(step.text.trim().toLowerCase())
        ? step.text.trim().toLowerCase()
        : 'synthetic unrelated input',
      ...(step.session
        ? {
            session: {
              ...step.session,
              ...(step.session.participants
                ? {
                    participants: Object.fromEntries(
                      Object.entries(step.session.participants).map(([id, participant]) => [
                        identity(id),
                        participant,
                      ]),
                    ),
                  }
                : {}),
            },
          }
        : {}),
    })),
  }));
}
