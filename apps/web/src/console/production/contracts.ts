import { z } from 'zod';
const name = z.string().max(120),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const kindSchema = z.enum(['obs', 'streamerbot', 'firebot']);
export const botKindSchema = z.enum(['streamerbot', 'firebot']);
export const mappingSchema = z
  .object({
    id: name,
    eventName: name,
    versionId: z.string(),
    control: z.enum(['start', 'pause']),
    actionId: name.nullable(),
    tool: botKindSchema.optional(),
  })
  .strict();
const connection = z
  .object({
    status: z.enum(['disconnected', 'connecting', 'connected', 'error']),
    reason: z.string().nullable(),
    url: z.string().nullable(),
    scenes: z.array(name).max(500),
    actions: z.array(z.object({ id: name, name, enabled: z.boolean() })).max(500),
    commands: z.array(name).max(500).optional(),
  })
  .strict();
export const disconnected = {
  status: 'disconnected',
  reason: null,
  url: null,
  scenes: [],
  actions: [],
} satisfies z.input<typeof connection>;
export const stateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    configured: z.boolean(),
    origin: z.string(),
    connections: z.object({
      obs: connection,
      streamerbot: connection,
      // Older servers have no Firebot connector; treat it as not connected.
      firebot: connection.default(disconnected),
    }),
    obsReview: z
      .object({
        digest: hash,
        sceneName: name,
        inputName: name,
        width: z.number(),
        height: z.number(),
        operation: z.enum(['create', 'update']),
        status: z.enum(['review', 'test', 'live', 'rolled-back']),
        before: z
          .object({
            width: z.number().nullable(),
            height: z.number().nullable(),
            mode: z.literal('owned-browser'),
          })
          .nullable(),
      })
      .nullable(),
    mappingReview: z
      .object({
        digest: hash,
        mappings: z.array(mappingSchema).max(20),
        unsupported: z.array(z.string()).max(100),
        differences: z.array(z.string()).max(100),
      })
      .nullable(),
    mappings: z.array(mappingSchema).max(20),
    recent: z.array(z.object({ at: z.number(), code: z.string(), message: z.string() })).max(30),
  })
  .strict();
export type ProductionState = z.infer<typeof stateSchema>;
export type ProductionMapping = z.infer<typeof mappingSchema>;
export type BotKind = z.infer<typeof botKindSchema>;
export const toolOf = (m: ProductionMapping): BotKind => m.tool ?? 'streamerbot';

const importItem = z
  .object({
    id: z.string().regex(/^[a-f0-9]{16}$/),
    kind: z.enum([
      'action',
      'command',
      'event',
      'preset',
      'scene',
      'source',
      'script',
      'component',
    ]),
    name: z.string().max(200),
    status: z.enum(['mapped', 'review', 'imported', 'skipped']),
    trigger: z
      .object({
        kind: z.enum(['command', 'cheer', 'sub', 'raid', 'redemption', 'follow']),
        detail: z.string().max(200).nullable(),
      })
      .nullable(),
    actions: z
      .array(
        z.object({
          kind: z.enum(['scene', 'source-visibility', 'media', 'chat']),
          detail: z.string().max(300),
        }),
      )
      .max(60),
    review: z.array(z.string().max(400)).max(20),
    reason: z.string().max(400).nullable(),
    intent: z.string().max(1200).nullable(),
    bridge: z.string().max(120).nullable(),
    drafted: z.enum(['intent', 'bridge']).nullable(),
  })
  .strict();
export const importReportSchema = z
  .object({
    tool: z.enum(['streamerbot', 'firebot', 'obs']),
    title: z.string().max(200).nullable(),
    counts: z.object({
      imported: z.number().int().nonnegative(),
      mapped: z.number().int().nonnegative(),
      review: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    }),
    items: z.array(importItem).max(200),
    notes: z.array(z.string().max(400)).max(20),
  })
  .strict();
export const draftResultSchema = z.object({
  state: stateSchema,
  report: importReportSchema,
  intents: z
    .array(z.object({ id: z.string(), name: z.string().max(200), text: z.string().max(1200) }))
    .max(200),
});
export type ImportTool = z.infer<typeof importReportSchema>['tool'];
export type ImportReport = z.infer<typeof importReportSchema>;
export type ImportItem = z.infer<typeof importItem>;
export type DraftResult = z.infer<typeof draftResultSchema>;
