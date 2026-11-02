import { z } from 'zod';
import { sceneSchema } from '../../scenes/schema.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const language = z.enum(['en', 'fr', 'es', 'de']);
const license = z.enum(['MIT', 'CC0-1.0', 'CC-BY-4.0']);
const asset = z.enum(['tomato', 'star', 'heart']);
const color = z.string().regex(/^#[0-9a-f]{6}$/);
const localized = z.object({
  en: z.string().max(120).optional(),
  fr: z.string().max(120).optional(),
  es: z.string().max(120).optional(),
  de: z.string().max(120).optional(),
});
/** F29 declared parameters; the server enforces every bound again. */
export const parameterSchema = z.discriminatedUnion('id', [
  z.object({ id: z.literal('command'), kind: z.literal('command'), label: z.string().max(60) }),
  z.object({
    id: z.enum(['maxPerViewer', 'windowMs']),
    kind: z.literal('number'),
    label: z.string().max(60),
    min: z.number().int(),
    max: z.number().int(),
    step: z.number().int().min(1),
  }),
  z.object({
    id: z.literal('accent'),
    kind: z.literal('color'),
    label: z.string().max(60),
    palette: z.array(color).max(8),
    default: color,
  }),
  z.object({
    id: z.literal('headline'),
    kind: z.literal('copy'),
    label: z.string().max(60),
    maxLength: z.number().int().min(1).max(120),
    default: localized,
  }),
  z.object({
    id: z.literal('experienceTitle'),
    kind: z.literal('copy'),
    label: z.string().max(60),
    maxLength: z.number().int().min(1).max(120),
  }),
]);
export type RecipeParameter = z.infer<typeof parameterSchema>;
export type LocalizedCopy = z.infer<typeof localized>;
export const parameterChangeSchema = z.object({
  id: z.string(),
  field: z.string(),
  before: z.string(),
  after: z.string(),
  authority: z.enum(['widened', 'narrowed', 'unchanged', 'cosmetic']),
});
export const recipePackageSchema = z
  .object({
    version: z.literal(1),
    recipeId: z.string().min(1).max(80),
    revision: count.min(1),
    digest: hash,
    title: z.string().min(1).max(80),
    description: z.string().max(1000),
    author: z.string().min(1).max(80),
    license,
    rightsAttested: z.literal(true),
    source: z.string().max(16384),
    manifest: z.unknown(),
    tests: z.unknown(),
    scene: sceneSchema,
    presentation: z
      .object({
        language,
        reducedMotion: z.boolean(),
        highContrast: z.boolean().optional(),
        effectLabels: z.boolean().optional(),
      })
      .strict(),
    assets: z
      .array(
        z
          .object({ id: asset, credit: z.literal('Riff'), license: z.literal('project-license') })
          .strict(),
      )
      .max(3),
    lineage: z
      .array(
        z
          .object({
            recipeId: z.string().min(1).max(80),
            revision: count.min(1),
            digest: hash,
            author: z.string().max(80),
            license,
          })
          .strict(),
      )
      .max(8),
    parameters: z.array(parameterSchema).max(6).optional(),
  })
  .strict();
export const profileSchema = z.object({
  revision: count,
  displayName: z.string().min(1).max(80),
  language,
  reducedMotion: z.boolean(),
  highContrast: z.boolean().optional(),
  effectLabels: z.boolean().optional(),
  scene: sceneSchema,
  capabilities: z.array(z.enum(['overlay', 'session'])).max(2),
  command: z.string().regex(/^![a-z0-9_-]{1,32}$/),
  audience: z
    .array(z.enum(['viewer', 'subscriber', 'moderator', 'broadcaster']))
    .min(1)
    .max(4),
  maxPerViewer: z.number().int().min(1).max(100),
  windowMs: z.number().int().min(1000).max(3600000),
});
export const proofSchema = z.object({
  synthetic: z.literal(true),
  accepted: count,
  blocked: count,
  scores: z.record(z.string(), z.number()),
  contributions: count,
  steps: z
    .array(
      z.object({
        at: z.number().nonnegative(),
        text: z.string().max(500),
        code: z.string().max(64),
        reason: z.string().max(1000),
        effects: z.array(z.object({ asset, x: z.number().min(0).max(1) })).max(10),
      }),
    )
    .max(120),
});
export const reviewSchema = z.object({
  id: z.string(),
  digest: hash,
  sourceDigest: hash,
  profileRevision: count,
  artifactId: hash,
  source: z.string().max(16384),
  manifest: z.unknown(),
  tests: z.unknown(),
  scene: sceneSchema,
  differences: z
    .array(z.object({ field: z.string(), before: z.string(), after: z.string() }))
    .max(100),
  passed: z.boolean(),
  checks: z.array(z.string().max(500)).max(100),
  rehearsalHash: hash,
  installedVersionId: z.string().nullable(),
  targetVersionId: z.string().nullable(),
  proof: proofSchema,
  requiredTwitchScopes: z.tuple([z.literal('user:read:chat')]),
  parameters: z
    .object({
      changes: z.array(parameterChangeSchema).max(6),
      style: z.object({ accent: color.optional(), headline: localized.optional() }),
    })
    .optional(),
});
export const publicationSchema = z.object({
  package: recipePackageSchema,
  withheld: z.boolean(),
  proof: proofSchema,
  samples: z.array(z.object({ at: z.number(), asset, x: z.number().min(0).max(1) })).max(1200),
});
export const stateSchema = z.object({
  profile: profileSchema,
  imports: z
    .array(
      z.object({
        digest: hash,
        package: recipePackageSchema,
        supported: z.boolean(),
        blockers: z.array(z.string()),
      }),
    )
    .max(50),
  reviews: z.array(reviewSchema).max(50),
  publications: z.array(publicationSchema).max(50),
  /** Editions this channel exported (published or not); the server numbers new editions. */
  exports: z
    .array(
      z.object({
        digest: hash,
        recipeId: z.string().nullable(),
        revision: z.number().int().nullable(),
        title: z.string().nullable(),
      }),
    )
    .max(50)
    .optional(),
  reports: z
    .array(
      z.object({
        id: z.string(),
        digest: hash,
        reason: z.string().max(500),
        status: z.enum(['open', 'resolved']),
        createdAt: z.number(),
      }),
    )
    .max(100),
});
export type RecipePackage = z.infer<typeof recipePackageSchema>;
export type RecipeProfile = z.infer<typeof profileSchema>;
export type RecipeProof = z.infer<typeof proofSchema>;
export type RecipeReview = z.infer<typeof reviewSchema>;
export type RecipePublication = z.infer<typeof publicationSchema>;
export type RecipeState = z.infer<typeof stateSchema>;
export function requirements(manifest: unknown) {
  const result = z
    .object({
      sdkVersion: z.string(),
      experience: z
        .object({
          title: z.string(),
          durationMs: z.number(),
          teams: z.array(z.object({ joinCommand: z.string() })),
          resource: z.object({ name: z.string(), perParticipant: z.number() }),
          contribution: z.object({ command: z.string() }),
        })
        // Stateless SDK 0.4 manifests carry an explicit null experience.
        .nullish(),
      capabilities: z.array(z.string()),
      trigger: z.object({
        command: z.string(),
        audience: z.array(z.string()),
        maxPerViewer: z.number(),
        windowMs: z.number(),
      }),
    })
    .safeParse(manifest);
  return result.success ? result.data : null;
}
export function downloadRecipe(recipe: RecipePackage) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `riff-recipe-${recipe.recipeId}-v${recipe.revision}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
