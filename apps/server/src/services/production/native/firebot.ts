import { z } from 'zod';
import type { ProductionImportTrigger } from '@riff/sdk';
import { ProductionError } from '../contract.js';
import { LIMITS, asArray, asRecord, basename, clean, type Found } from './common.js';

/**
 * Firebot v5 setup files (`.firebotsetup`): `FirebotSetup` in crowbartools/Firebot
 * `src/types/setups.ts`. Saved events match on `sourceId`/`eventId`
 * (`src/backend/events/events-router.js`); Twitch event ids come from
 * `src/backend/streaming-platforms/twitch/events/index.ts`; effect type ids from
 * `src/backend/effects/builtin/*` and the built-in OBS integration (checked
 * November 1, 2026). Effects are read as data; none is run.
 */
const effectList = z.object({ list: z.array(z.unknown()).optional() }).passthrough();
const setupSchema = z
  .object({
    name: z.string().optional(),
    components: z.record(z.string(), z.array(z.unknown())),
  })
  .passthrough();

const TWITCH_EVENTS: Record<string, ProductionImportTrigger> = {
  cheer: 'cheer',
  sub: 'sub',
  'subs-gifted': 'sub',
  'community-subs-gifted': 'sub',
  'prime-sub-upgraded': 'sub',
  'gift-sub-upgraded': 'sub',
  raid: 'raid',
  'channel-reward-redemption': 'redemption',
  follow: 'follow',
};

/** Effect types that would run code or programs on the creator's machine. */
const EXECUTABLE: Record<string, string> = {
  'firebot:customscript': 'Custom script effect',
  'firebot:run-program': 'Run program effect',
  'firebot:eval-js': 'JavaScript evaluation effect',
};

/** Components with no Riff equivalent; listed by count, never imported. */
const OTHER_COMPONENTS: Record<string, string> = {
  counters: 'counters',
  currencies: 'currencies',
  effectQueues: 'effect queues',
  hotkeys: 'hotkeys',
  timers: 'timers',
  scheduledTasks: 'scheduled effect lists',
  variableMacros: 'variable macros',
  viewerRoles: 'viewer roles',
  viewerRankLadders: 'viewer rank ladders',
  quickActions: 'quick actions',
  overlayWidgetConfigs: 'overlay widgets',
  globalValues: 'global values',
};

function effects(raw: unknown) {
  const out: { actions: NonNullable<Found['actions']>; review: string[] } = {
    actions: [],
    review: [],
  };
  const listed = asArray(effectList.safeParse(raw).data?.list);
  for (const value of listed.slice(0, LIMITS.partsPerItem)) {
    const effect = asRecord(value);
    if (!effect) continue;
    if (effect.active === false) continue;
    const type = clean(effect.type, 80) ?? 'unknown';
    const label = clean(effect.effectLabel, 60);
    if (EXECUTABLE[type]) {
      out.review.push(
        `${EXECUTABLE[type]}${label ? ` "${label}"` : ''} was not imported or run; review it manually.`,
      );
      continue;
    }
    const push = (kind: NonNullable<Found['actions']>[number]['kind'], detail: string | null) =>
      detail
        ? out.actions.push({ kind, detail })
        : out.review.push(`Effect "${type}" is missing its target and was not imported.`);
    if (type === 'firebot:chat') push('chat', clean(effect.message, 200));
    else if (type === 'firebot:playsound') push('media', basename(effect.filepath));
    else if (type === 'firebot:playvideo')
      push('media', basename(effect.file) ?? clean(effect.videoType, 60));
    else if (type === 'ebiggz:obs-change-scene') push('scene', clean(effect.sceneName));
    else if (type === 'ebiggz:obs-toggle-source-visibility') {
      const sources = asArray(effect.selectedSources).map(asRecord).filter(Boolean);
      if (!sources.length) push('source-visibility', null);
      for (const source of sources.slice(0, 5))
        push(
          'source-visibility',
          clean(source?.sourceName) ??
            (clean(source?.sceneName)
              ? `item ${String(source?.sourceId)} in ${clean(source?.sceneName)}`
              : null),
        );
    } else
      out.review.push(
        `Effect "${type}"${label ? ` ("${label}")` : ''} has no Riff equivalent and was not imported.`,
      );
  }
  if (listed.length > LIMITS.partsPerItem)
    out.review.push(`${listed.length - LIMITS.partsPerItem} more effects were not read.`);
  return out;
}

export function readFirebot(doc: unknown) {
  const parsed = setupSchema.safeParse(doc);
  if (!parsed.success)
    throw new ProductionError(
      'INVALID',
      'This is not a Firebot setup file. Export one from Firebot → Setups → Create Setup and import the .firebotsetup file.',
    );
  const { components } = parsed.data;
  const found: Found[] = [];
  const notes: string[] = [];

  for (const value of components.commands ?? []) {
    const c = asRecord(value);
    if (!c) continue;
    const trigger = clean(c.trigger, 80) ?? 'unnamed command';
    const key = clean(c.id, 120) ?? trigger;
    if (c.active === false) {
      found.push({ kind: 'command', key, name: trigger, skip: 'Command is disabled in Firebot.' });
      continue;
    }
    const e = effects(c.effects);
    if (c.triggerIsRegex === true)
      e.review.push('The trigger is a regular expression; Riff kept it as plain text.');
    if (asArray(c.subCommands).length)
      e.review.push('Subcommands were not imported; review them manually.');
    found.push({
      kind: 'command',
      key,
      name: trigger,
      trigger: { kind: 'command', detail: trigger },
      ...e,
      bridgeable: true,
    });
  }

  const events = [
    ...(components.events ?? []),
    ...(components.eventGroups ?? []).flatMap((g) => asArray(asRecord(g)?.events)),
  ];
  for (const value of events) {
    const ev = asRecord(value);
    if (!ev) continue;
    const source = clean(ev.sourceId, 60) ?? 'unknown';
    const eventId = clean(ev.eventId, 60) ?? 'unknown';
    const name = clean(ev.name, 80) ?? `${source}:${eventId}`;
    const key = clean(ev.id, 120) ?? name;
    if (ev.active === false) {
      found.push({ kind: 'event', key, name, skip: 'Event is disabled in Firebot.' });
      continue;
    }
    const kind = source === 'twitch' ? TWITCH_EVENTS[eventId] : undefined;
    const e = effects(ev.effects);
    if (!kind)
      e.review.push(`Firebot event "${source}:${eventId}" has no Riff trigger equivalent.`);
    if (asRecord(ev.filterData) && asArray(asRecord(ev.filterData)?.filters).length)
      e.review.push('Event filters were not imported; the draft applies to every such event.');
    found.push({
      kind: 'event',
      key,
      name,
      trigger: kind ? { kind, detail: null } : null,
      ...e,
      bridgeable: true,
    });
  }

  for (const value of components.presetEffectLists ?? []) {
    const p = asRecord(value);
    if (!p) continue;
    const name = clean(p.name, 80) ?? 'Unnamed preset effect list';
    const e = effects(p.effects);
    found.push({
      kind: 'preset',
      key: clean(p.id, 120) ?? name,
      name,
      ...e,
      reason: 'Preset effect list. After connecting Firebot it can run when a Riff round finishes.',
    });
  }

  for (const [key, label] of Object.entries(OTHER_COMPONENTS)) {
    const n = (components[key] ?? []).length;
    if (n)
      found.push({
        kind: 'component',
        key,
        name: `${n} Firebot ${label}`,
        skip: `Firebot ${label} have no Riff equivalent and were not imported.`,
      });
  }
  const known = new Set([
    'commands',
    'events',
    'eventGroups',
    'presetEffectLists',
    ...Object.keys(OTHER_COMPONENTS),
  ]);
  for (const key of Object.keys(components))
    if (!known.has(key) && components[key]?.length)
      notes.push(`Unrecognised Firebot component "${clean(key, 40)}" was not imported.`);
  if (asArray((doc as Record<string, unknown>).importQuestions).length)
    notes.push('Setup import questions were not answered; their placeholders stay as written.');
  return { title: clean(parsed.data.name, 120), found, notes };
}
