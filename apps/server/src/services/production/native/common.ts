import type {
  ProductionImportAction,
  ProductionImportItem,
  ProductionImportTool,
  ProductionImportTrigger,
} from '@riff/sdk';
import { digest } from '../contract.js';

/**
 * Shared helpers for native configuration import. Every imported string is untrusted
 * data: it is cleaned, length-capped and only ever displayed or quoted in a proposed
 * intent the creator reviews. Nothing imported is evaluated, fetched or executed.
 */
export const LIMITS = {
  textBytes: 256 * 1024,
  decodedBytes: 1024 * 1024,
  items: 200,
  partsPerItem: 50,
  reviewPerItem: 12,
  notes: 20,
  intent: 1200,
} as const;

export const TOOL_LABEL: Record<ProductionImportTool, string> = {
  streamerbot: 'Streamer.bot',
  firebot: 'Firebot',
  obs: 'OBS',
};

/** Strip control characters, collapse whitespace and cap length; null when empty. */
export function clean(value: unknown, max = 80): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value)
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Final path segment only: local directory layouts never leave the import. */
export const basename = (value: unknown) =>
  clean(typeof value === 'string' ? value.split(/[\\/]/).pop() : null);

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** One item found in a native document before its status and drafts are decided. */
export interface Found {
  kind: ProductionImportItem['kind'];
  /** Stable source identity (tool id when present, otherwise the name). */
  key: string;
  name: string;
  trigger?: { kind: ProductionImportTrigger; detail: string | null } | null;
  actions?: { kind: ProductionImportAction; detail: string }[];
  review?: string[];
  /** A skipped item is listed with this reason and offers no draft. */
  skip?: string;
  reason?: string | null;
  /** A recognised trigger in a bot tool can become a bridge mapping draft. */
  bridgeable?: boolean;
}

const TRIGGER_TEXT: Record<ProductionImportTrigger, (detail: string | null) => string> = {
  command: (d) => `a viewer types ${d ? `"${d}"` : 'the chat command'} in chat`,
  cheer: () => 'a viewer cheers bits',
  sub: () => 'a viewer subscribes or gifts a subscription',
  raid: () => 'another channel raids',
  redemption: (d) =>
    `a viewer redeems ${d ? `the "${d}" channel point reward` : 'a channel point reward'}`,
  follow: () => 'a viewer follows',
};
const ACTION_TEXT: Record<ProductionImportAction, (detail: string) => string> = {
  scene: (d) => `switch to the "${d}" scene`,
  'source-visibility': (d) => `change visibility of the "${d}" source`,
  media: (d) => `play "${d}"`,
  chat: (d) => `post "${d}" in chat`,
};

const list = (parts: string[]) =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;

/** A plain-language authoring intent describing only the recognised parts. */
export function intentFor(tool: ProductionImportTool, found: Found): string | null {
  if (!found.trigger || !found.actions?.length) return null;
  const text =
    `Imported from ${TOOL_LABEL[tool]} "${found.name}": when ${TRIGGER_TEXT[found.trigger.kind](found.trigger.detail)}, ` +
    `${list(found.actions.map((a) => ACTION_TEXT[a.kind](a.detail)))}.` +
    (found.review?.length ? ' Some original steps need manual review and were left out.' : '');
  return text.length > LIMITS.intent ? `${text.slice(0, LIMITS.intent - 1)}…` : text;
}

export function itemId(tool: ProductionImportTool, kind: string, key: string) {
  return digest({ tool, kind, key }).slice(0, 16);
}

/** Decide status, intent and bridge for every found item; bounded and deterministic. */
export function finalize(tool: ProductionImportTool, found: Found[], notes: string[]) {
  const kept = found.slice(0, LIMITS.items);
  if (found.length > kept.length)
    notes.push(
      `Only the first ${LIMITS.items} items were read; ${found.length - kept.length} more were not imported.`,
    );
  const seen = new Set<string>();
  const items: ProductionImportItem[] = kept.map((f) => {
    let id = itemId(tool, f.kind, f.key);
    // Duplicate source identities (same name twice) still get distinct, stable ids.
    for (let n = 2; seen.has(id); n++) id = itemId(tool, f.kind, `${f.key}#${n}`);
    seen.add(id);
    const review = [...(f.review ?? [])];
    if (review.length > LIMITS.reviewPerItem) {
      const extra = review.length - LIMITS.reviewPerItem + 1;
      review.splice(LIMITS.reviewPerItem - 1, Infinity, `${extra} more parts need manual review.`);
    }
    const trigger = f.skip ? null : (f.trigger ?? null);
    const actions = f.skip ? [] : (f.actions ?? []);
    if (!f.skip && trigger && !actions.length)
      review.push('No supported Riff actions were found for this trigger.');
    const status: ProductionImportItem['status'] = f.skip
      ? 'skipped'
      : trigger && actions.length && !review.length
        ? 'mapped'
        : review.length
          ? 'review'
          : 'imported';
    return {
      id,
      kind: f.kind,
      name: f.name,
      status,
      trigger,
      actions,
      review: f.skip ? [] : review,
      reason: f.skip ?? f.reason ?? null,
      intent: f.skip ? null : intentFor(tool, { ...f, review }),
      bridge: !f.skip && f.bridgeable && trigger ? (clean(f.name, 120) ?? null) : null,
      drafted: null,
    };
  });
  const count = (status: ProductionImportItem['status']) =>
    items.filter((i) => i.status === status).length;
  return {
    items,
    notes: notes.slice(0, LIMITS.notes),
    counts: {
      imported: items.length - count('skipped'),
      mapped: count('mapped'),
      review: count('review'),
      skipped: count('skipped'),
    },
  };
}
