import { z } from 'zod';
import type { ProductionImportTrigger } from '@riff/sdk';
import { ProductionError } from '../contract.js';
import { LIMITS, asArray, asRecord, basename, clean, type Found } from './common.js';

/**
 * Streamer.bot action exports.
 *
 * UNVERIFIED: Streamer.bot does not publish its export schema. The shape read here
 * (`{ data: { actions: [{ id, name, enabled, group, triggers, subActions }],
 * commands: [{ id, command }] } }`, with a `$type`/`type` discriminator on triggers
 * and sub-actions) is inferred, not documented. Recognition therefore relies on
 * descriptive type names and target fields only; anything not recognised is listed
 * for manual review rather than guessed, and nothing is ever executed.
 */
const actionSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
    enabled: z.boolean().optional(),
    group: z.string().nullish(),
    triggers: z.array(z.unknown()).optional(),
    subActions: z.array(z.unknown()).optional(),
  })
  .passthrough();
const exportSchema = z
  .object({
    data: z
      .object({
        actions: z.array(z.unknown()),
        commands: z.array(z.unknown()).optional(),
      })
      .passthrough(),
    meta: z.object({ name: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const typeText = (part: Record<string, unknown>) =>
  [part.$type, part.typeName, part.name, typeof part.type === 'string' ? part.type : null]
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
const describe = (part: Record<string, unknown>) =>
  // `Namespace.TypeName, Assembly` → `TypeName`
  clean(typeText(part).split(',')[0]?.split('.').filter(Boolean).at(-1) ?? null, 60) ??
  (typeof part.type === 'number' ? `type ${part.type}` : 'unknown');

function trigger(
  part: Record<string, unknown>,
  commands: Map<string, string>,
): { kind: ProductionImportTrigger; detail: string | null } | null {
  const text = typeText(part);
  if (typeof part.commandId === 'string' || /command/i.test(text))
    return {
      kind: 'command',
      detail: typeof part.commandId === 'string' ? (commands.get(part.commandId) ?? null) : null,
    };
  if (/cheer|bits/i.test(text)) return { kind: 'cheer', detail: null };
  if (/raid/i.test(text)) return { kind: 'raid', detail: null };
  if (/reward|redemption|redeem/i.test(text))
    return { kind: 'redemption', detail: clean(part.rewardTitle ?? part.title, 60) };
  if (/sub/i.test(text)) return { kind: 'sub', detail: null };
  if (/follow/i.test(text)) return { kind: 'follow', detail: null };
  return null;
}

function subAction(
  part: Record<string, unknown>,
  found: Required<Pick<Found, 'actions' | 'review'>>,
) {
  const text = typeText(part);
  const label = describe(part);
  if (/c#|csharp|code|script|compile/i.test(text) || 'byteCode' in part || 'code' in part) {
    found.review.push(`C# code sub-action "${label}" was not imported or run; review it manually.`);
    return;
  }
  if (/program|process|shell|exec/i.test(text) || 'arguments' in part) {
    found.review.push(`"${label}" would run a program on your PC; it was not imported.`);
    return;
  }
  if (asArray(part.subActions).length) {
    found.review.push(`Grouped or conditional sub-actions in "${label}" were not followed.`);
    return;
  }
  const scene = clean(part.sceneName ?? part.scene);
  const source = clean(part.sourceName ?? part.source);
  if (/visib/i.test(text) && source)
    found.actions.push({ kind: 'source-visibility', detail: source });
  else if (/scene/i.test(text) && scene && !source)
    found.actions.push({ kind: 'scene', detail: scene });
  else if (
    /sound|media|audio|video/i.test(text) &&
    basename(part.soundFile ?? part.file ?? part.filePath)
  )
    found.actions.push({
      kind: 'media',
      detail: basename(part.soundFile ?? part.file ?? part.filePath) as string,
    });
  else if (/message|chat|reply/i.test(text) && clean(part.text ?? part.message, 200))
    found.actions.push({ kind: 'chat', detail: clean(part.text ?? part.message, 200) as string });
  else if (/action/i.test(text) && 'actionId' in part)
    found.review.push(`"${label}" runs another Streamer.bot action, which was not followed.`);
  else found.review.push(`Sub-action "${label}" has no Riff equivalent and was not imported.`);
}

export function readStreamerBot(doc: unknown) {
  const parsed = exportSchema.safeParse(doc);
  if (!parsed.success)
    throw new ProductionError(
      'INVALID',
      'This is not a Streamer.bot action export. In Streamer.bot, right-click actions → Export, then paste the export string here.',
    );
  const commands = new Map<string, string>();
  for (const value of parsed.data.data.commands ?? []) {
    const c = asRecord(value);
    const id = typeof c?.id === 'string' ? c.id : null;
    const text = typeof c?.command === 'string' ? clean(c.command.split(/\r?\n/)[0], 80) : null;
    if (id && text) commands.set(id, text);
  }
  const found: Found[] = [];
  const notes: string[] = [
    'Streamer.bot export recognition is best-effort: its format is not publicly documented, so unrecognised parts are listed for review.',
  ];
  for (const value of parsed.data.data.actions) {
    const a = actionSchema.safeParse(value);
    if (!a.success) {
      found.push({
        kind: 'action',
        key: `invalid-${found.length}`,
        name: 'Unreadable action',
        skip: 'This action entry has no name and was not imported.',
      });
      continue;
    }
    const name = clean(a.data.name, 80) ?? 'Unnamed action';
    const key = clean(a.data.id, 120) ?? name;
    if (a.data.enabled === false) {
      found.push({ kind: 'action', key, name, skip: 'Action is disabled in Streamer.bot.' });
      continue;
    }
    const parts = { actions: [] as NonNullable<Found['actions']>, review: [] as string[] };
    const triggers = (a.data.triggers ?? []).map(asRecord).filter((t) => t !== null);
    const recognised = triggers.map((raw) => ({ raw, t: trigger(raw, commands) }));
    const first = recognised.find((r) => r.t !== null)?.t ?? null;
    recognised.forEach(({ raw, t }) => {
      if (t === null) parts.review.push(`Trigger "${describe(raw)}" has no Riff equivalent.`);
      else if (t !== first)
        parts.review.push(
          `Additional ${t.kind} trigger was not included; draft a separate interaction for it.`,
        );
    });
    const subs = (a.data.subActions ?? []).map(asRecord).filter((s) => s !== null);
    for (const s of subs.slice(0, LIMITS.partsPerItem)) subAction(s, parts);
    if (subs.length > LIMITS.partsPerItem)
      parts.review.push(`${subs.length - LIMITS.partsPerItem} more sub-actions were not read.`);
    found.push({
      kind: 'action',
      key,
      name,
      trigger: first,
      ...parts,
      bridgeable: true,
      reason: triggers.length
        ? null
        : 'No trigger. After connecting Streamer.bot it can run when a Riff round finishes.',
    });
  }
  return { title: clean(parsed.data.meta?.name, 120), found, notes };
}
