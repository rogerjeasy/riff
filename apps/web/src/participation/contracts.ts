import { z } from 'zod';
export const languageSchema = z.enum(['en', 'fr', 'es', 'de']);
export const settingsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    language: z.enum(['inherit', 'en', 'fr', 'es', 'de']),
    reducedMotion: z.boolean(),
    highContrast: z.boolean(),
    effectLabels: z.boolean(),
  })
  .strict();
export type ParticipationSettings = z.infer<typeof settingsSchema>;
export const preferencesSchema = z
  .object({ language: languageSchema, reducedMotion: z.boolean(), highContrast: z.boolean() })
  .strict();
export const guidanceSchema = z
  .object({
    language: languageSchema,
    stopped: z.boolean(),
    reducedMotion: z.boolean(),
    highContrast: z.boolean(),
    helpCommand: z.string().max(60),
    interactions: z
      .array(
        z
          .object({
            id: z.string(),
            title: z.string().max(120),
            phase: z.enum(['running', 'paused', 'finished']),
            free: z.boolean(),
            instructions: z.array(z.string().max(200)).max(4),
            objective: z.string().max(200),
            remainingMs: z.number().nonnegative().nullable(),
            scores: z
              .array(z.object({ label: z.string().max(120), score: z.number().nonnegative() }))
              .max(8),
            outcome: z.string().max(200).nullable(),
            // Optional structured fields the page highlights when the host provides them.
            command: z.string().max(60).optional(),
            audience: z
              .array(z.enum(['viewer', 'subscriber', 'moderator', 'broadcaster']))
              .max(4)
              .optional(),
            joinCommands: z.array(z.string().max(60)).max(8).optional(),
            goal: z
              .object({ target: z.number().nonnegative(), current: z.number().nonnegative() })
              .nullable()
              .optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type Guidance = z.infer<typeof guidanceSchema>;
export const languages = [
  ['en', 'English'],
  ['fr', 'Français'],
  ['es', 'Español'],
  ['de', 'Deutsch'],
] as const;
