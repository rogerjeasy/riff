import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { ProductionMapping, ObsSetupReview, ProductionMappingReview } from '@riff/sdk';
export class ProductionError extends Error {
  constructor(
    readonly code: 'INVALID' | 'STALE' | 'DENIED' | 'BUSY' | 'UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}
/**
 * An adapter's plain-language explanation of why the external tool refused or could
 * not safely perform an operation. The service surfaces its message to the creator;
 * any other adapter error is reported generically.
 */
export class ToolRefusal extends Error {}
export const name = z.string().trim().min(1).max(120);
export const kindSchema = z.enum(['obs', 'streamerbot', 'firebot']);
export const botKindSchema = z.enum(['streamerbot', 'firebot']);
export const mappingSchema = z
  .object({
    id: name,
    eventName: name,
    versionId: z.string().uuid(),
    control: z.enum(['start', 'pause']),
    actionId: name.nullable(),
    tool: botKindSchema.optional(),
  })
  .strict();
export const mappingsSchema = z
  .array(mappingSchema)
  .max(20)
  .refine(
    (m) =>
      new Set(m.map((x) => x.id)).size === m.length &&
      new Set(m.map((x) => x.eventName)).size === m.length,
    'Use unique mapping IDs and event names',
  );
export const importSchema = z
  .object({ format: z.literal('riff-production'), version: z.literal(1), mappings: mappingsSchema })
  .strict();
export const setupSchema = z
  .object({
    sceneName: name,
    inputName: name,
    width: z.number().int().min(320).max(3840),
    height: z.number().int().min(240).max(2160),
  })
  .strict();
export const connectSchema = z
  .object({
    kind: kindSchema,
    url: z.string().max(300),
    password: z.string().min(1).max(500),
    discover: z.literal(true),
  })
  .strict();
export const metadataSchema = z
  .object({
    eventId: name,
    causalId: name,
    origin: name,
    hops: z.number().int().min(0).max(2),
    at: z.number().int().nonnegative().safe(),
  })
  .strict();
export const eventSchema = z.object({ eventName: name, args: z.object({ riff: metadataSchema }) });
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
      .join(',') +
    '}'
  );
}
export const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
/** Plaintext sockets are limited to explicitly entered local/private IP endpoints. */
export function connectionUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ProductionError('INVALID', 'Enter a valid WebSocket endpoint.');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const octets = host.split('.').map(Number);
  const local =
    host === 'localhost' ||
    host === '::1' ||
    (isIP(host) === 4 &&
      (octets[0] === 127 ||
        octets[0] === 10 ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && (octets[1] ?? -1) >= 16 && (octets[1] ?? -1) <= 31)));
  if (
    !['ws:', 'wss:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    host === '169.254.169.254' ||
    host === '0.0.0.0' ||
    host === '::' ||
    (u.protocol === 'ws:' && !local)
  )
    throw new ProductionError(
      'INVALID',
      'Use a local/private ws endpoint or a secured wss endpoint, without URL credentials or query strings.',
    );
  return u.toString();
}
const privateHost = (host: string) => {
  const octets = host.split('.').map(Number);
  return (
    host === 'localhost' ||
    host === '::1' ||
    (isIP(host) === 4 &&
      (octets[0] === 127 ||
        octets[0] === 10 ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && (octets[1] ?? -1) >= 16 && (octets[1] ?? -1) <= 31)))
  );
};
/**
 * Firebot's HTTP API has no authentication, so Riff only reaches it on an explicitly
 * entered local/private address (http or https), never a public host.
 */
export function firebotUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ProductionError(
      'INVALID',
      'Enter a valid Firebot address, such as http://127.0.0.1:7472.',
    );
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.pathname !== '/' && u.pathname !== '') ||
    !privateHost(host)
  )
    throw new ProductionError(
      'INVALID',
      'Firebot has no API authentication, so use its local or private-network address (for example http://127.0.0.1:7472) without credentials, paths or query strings.',
    );
  return u.toString();
}
/** Minimum length of the creator-chosen key that authenticates inbound Firebot events. */
export const FIREBOT_KEY_MIN = 12;
/** Discovery lists are bounded by the service, which reports skipped entries. */
export const discoveryLimits = { scenes: 200, actions: 500, name: 120 } as const;
export interface ObsTransport {
  connect(url: string, password: string): Promise<void>;
  disconnect(): void;
  scenes(): Promise<string[]>;
  input(scene: string, name: string): Promise<Record<string, unknown> | null>;
  write(
    scene: string,
    name: string,
    settings: Record<string, unknown>,
    create: boolean,
    restore?: boolean,
  ): Promise<void>;
  remove(scene: string, name: string): Promise<void>;
}
export interface BotTransport {
  connect(url: string, password: string): Promise<void>;
  disconnect(): void;
  actions(): Promise<{ id: string; name: string; enabled: boolean }[]>;
  invoke(actionId: string, args: Record<string, unknown>): Promise<void>;
  /** Read-only command discovery (Firebot); shown to the creator, never invoked. */
  commands?(): Promise<{ id: string; trigger: string }[]>;
}
export type SetupInput = z.infer<typeof setupSchema>;
export type ConnectInput = z.infer<typeof connectSchema>;
export interface StoredSetup {
  public: ObsSetupReview;
  /** Random identity of the OBS connection that produced this review. Apply and
   * confirm require the same live connection; rollback survives reconnection. */
  connection: string;
  beforeSealed: string | null;
  expectedSealed: string | null;
  urlDigest: string;
}
/** Passwords are never persisted: every connection requires explicit re-entry. */
export interface StoredProduction {
  revision: number;
  origin: string;
  setup: StoredSetup | null;
  mappingReview: ProductionMappingReview | null;
  mappings: ProductionMapping[];
  receipts: { id: string; causal: string; at: number }[];
  completed: Record<string, string>;
  /** Native import items already drafted, keyed `${tool}:${itemId}` (idempotent re-import). */
  imports?: Record<string, 'intent' | 'bridge'>;
}
