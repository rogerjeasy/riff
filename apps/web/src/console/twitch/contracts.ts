import { z } from 'zod';

/** F19 Twitch event families, mirrored from the server trigger table. */
export const twitchEventKinds = ['subscribe', 'gift', 'resub', 'cheer', 'raid'] as const;
export type TwitchEventKind = (typeof twitchEventKinds)[number];

export const twitchTriggerSchema = z
  .object({
    name: z.enum(twitchEventKinds),
    label: z.string().max(80),
    eventSubType: z.string().max(80),
    version: z.string().max(8),
    docs: z.string().url().max(300),
    consent: z.string().max(40),
    scopes: z.array(z.string().max(60)).max(8),
    missingScopes: z.array(z.string().max(60)).max(8),
    inUse: z.boolean(),
    subscription: z.enum([
      'active',
      'pending',
      'missing-consent',
      'failed',
      'revoked',
      'idle',
      'offline',
    ]),
    message: z.string().max(300).nullable(),
  })
  .strip();
export const twitchTriggersSchema = z
  .object({ configured: z.boolean(), triggers: z.array(twitchTriggerSchema).max(16) })
  .strip();
export type TwitchTrigger = z.infer<typeof twitchTriggerSchema>;

/** Synthetic Twitch event detail accepted by private previews (never sent to Twitch). */
export const twitchEventDetailSchema = z
  .object({
    kind: z.enum(twitchEventKinds),
    amount: z.number().int().min(1).max(10_000_000),
    tier: z.enum(['1000', '2000', '3000']).nullable(),
    anonymous: z.boolean(),
    gift: z.boolean(),
  })
  .strict();
export type TwitchEventDetail = z.infer<typeof twitchEventDetailSchema>;

/** Per-kind copy for the console: what the amount means and a sensible simulation. */
export const EVENT_COPY: Record<
  TwitchEventKind,
  { noun: string; unit: string; sample: number; verb: (amount: number) => string }
> = {
  subscribe: {
    noun: 'subscription',
    unit: 'sub',
    sample: 1,
    verb: () => 'subscribed',
  },
  gift: {
    noun: 'gift',
    unit: 'gifted subs',
    sample: 5,
    verb: (n) => `gifted ${n} sub${n === 1 ? '' : 's'}`,
  },
  resub: {
    noun: 'resub',
    unit: 'months',
    sample: 12,
    verb: (n) => `resubscribed for ${n} month${n === 1 ? '' : 's'}`,
  },
  cheer: { noun: 'cheer', unit: 'bits', sample: 100, verb: (n) => `cheered ${n} bits` },
  raid: {
    noun: 'raid',
    unit: 'viewers',
    sample: 25,
    verb: (n) => `raided with ${n} viewer${n === 1 ? '' : 's'}`,
  },
};

/** Build a valid synthetic detail for a preview. Example: syntheticEvent('cheer', 100). */
export function syntheticEvent(
  kind: TwitchEventKind,
  amount: number,
  anonymous = false,
): TwitchEventDetail {
  const subscription = kind === 'subscribe' || kind === 'gift' || kind === 'resub';
  return {
    kind,
    amount: kind === 'subscribe' ? 1 : Math.max(1, Math.min(10_000_000, Math.trunc(amount) || 1)),
    tier: subscription ? '1000' : null,
    anonymous: anonymous && (kind === 'cheer' || kind === 'gift'),
    gift: false,
  };
}
