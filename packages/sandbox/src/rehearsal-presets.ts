import { z } from 'zod';
import type { ChatEvent, DecisionCode, PermissionManifest } from '@riff/sdk';
import { artifactSchema } from './contract.js';
import { syntheticTwitchEvent } from './verify.js';
import { formatSampleText, slotAt, slotMs } from './formats.js';
import {
  RehearsalError,
  rehearsalScenarioSchema,
  type RehearsalScenario,
  type RehearsalStep,
} from './rehearsal-contract.js';

export const REHEARSAL_PRESETS = [
  'proof',
  'crowd-burst',
  'duplicate-delivery',
  'late-arrival',
  'exhaustion',
  'deadline',
  'burst',
  'elimination',
  'match',
  'unlock',
  'paint',
  'stages',
  'answers',
] as const;
export type RehearsalPreset = (typeof REHEARSAL_PRESETS)[number];
/** Version 2 mechanic presets that apply to this manifest. Example: mechanicPresetsFor(manifest). */
export function mechanicPresetsFor(manifest: PermissionManifest): RehearsalPreset[] {
  const m = manifest.experience?.mechanics;
  if (!m) return [];
  return [
    ...(m.burst ? (['burst'] as const) : []),
    ...(m.health ? (['elimination'] as const) : []),
    ...(m.match ? (['match'] as const) : []),
    ...(m.milestones.some((x) => x.unlock) ? (['unlock'] as const) : []),
  ];
}
/** Version 3 format presets that apply to this manifest. Example: formatPresetsFor(manifest). */
export function formatPresetsFor(manifest: PermissionManifest): RehearsalPreset[] {
  const kind = manifest.experience?.format?.kind;
  return kind === 'mural'
    ? ['paint']
    : kind === 'composition'
      ? ['stages']
      : kind === 'quiz'
        ? ['answers']
        : [];
}
/** Construct explicitly synthetic normalized inputs using the chosen manifest's commands and limits. */
export function createRehearsalPreset(
  candidate: unknown,
  preset: RehearsalPreset,
  seed: number,
): RehearsalScenario {
  z.enum(REHEARSAL_PRESETS).parse(preset);
  const { manifest } = artifactSchema.parse(candidate);
  const definition = manifest.experience;
  // Acceptance requires both the viewer window and the cosmetic channel window to expire.
  const statelessWindowMs = Math.max(manifest.trigger.windowMs, 60_000);
  const reachesGoal = (contributions: number) =>
    definition?.objective.kind === 'collective-goal' &&
    definition.contribution.points * contributions >= (definition.objective.target ?? Infinity);
  const mechanics = definition?.mechanics;
  const health = mechanics?.health ?? null;
  // Contributions needed by one side to eliminate another; Infinity without health pools.
  const hitsToEliminate = health ? Math.ceil(health.max / health.damage) : Infinity;
  // A single contribution can end a version 2 round early; skip expectations it would change.
  const endsEarly = (contributions: number) =>
    reachesGoal(contributions) ||
    hitsToEliminate <= contributions ||
    (definition?.objective.kind === 'burst' &&
      mechanics?.burst?.command === null &&
      mechanics.burst.participants <= contributions);
  const unsafeV2 = (contributions: number) => Boolean(mechanics) && endsEarly(contributions);
  const after = (code: DecisionCode, contributions: number) =>
    unsafeV2(contributions) ? undefined : code;
  const steps: RehearsalStep[] = [];
  const expectations: RehearsalScenario['expectations'] = [];
  let clock = 0;
  const add = (
    text: string,
    viewerId = 'viewer-1',
    expected?: DecisionCode,
    roles = manifest.trigger.audience,
  ): ChatEvent => {
    const key = `step-${steps.length + 1}`;
    // F19: event triggers rehearse with labeled synthetic Twitch events at the threshold,
    // never fabricated EventSub transport messages.
    const trigger = manifest.trigger.kind === 'twitch.event' ? manifest.trigger.event : null;
    const synthetic = trigger && text === manifest.trigger.command;
    const event = {
      id: `${preset}-${key}`,
      channelId: 'rehearsal',
      viewerId,
      roles: [...roles],
      text: synthetic ? '' : text,
      at: ++clock,
      ...(synthetic ? { twitch: syntheticTwitchEvent(trigger.kind, trigger.minimum) } : {}),
    };
    steps.push({ kind: 'chat', key, event });
    if (expected) expectations.push({ id: key, stepKey: key, kind: 'decision', value: expected });
    return event;
  };
  const join = (viewerId = 'viewer-1') => {
    const team = definition?.teams[0];
    if (team) add(team.joinCommand, viewerId);
  };
  const advance = (at: number) => {
    clock = at;
    steps.push({ kind: 'advance', key: `step-${steps.length + 1}`, at });
  };
  // Version 3 formats need bounded arguments; the session starts at the first event
  // (at = 1), so the next event's elapsed time equals the current clock.
  const format = definition?.format;
  const act = (variant = 0) =>
    definition && format
      ? formatSampleText(definition, slotAt(definition, clock).slot, variant)
      : manifest.trigger.command;
  const finishPhase = () => {
    if (!definition) return;
    advance(definition.durationMs + 1);
    expectations.push({
      id: `step-${steps.length}`,
      stepKey: `step-${steps.length}`,
      kind: 'phase',
      value: 'finished',
    });
  };
  switch (preset) {
    case 'proof':
      add('unrelated rehearsal message', 'noise', 'UNRELATED');
      add(act(), 'ineligible', 'AUDIENCE', []);
      join();
      add(act(), 'viewer-1', 'ACCEPTED');
      break;
    case 'crowd-burst':
      for (let i = 0; i < Math.min(40, definition?.maxParticipants ?? 40); i++) {
        const viewer = `viewer-${i + 1}`;
        join(viewer);
        add(act(i), viewer);
      }
      break;
    case 'duplicate-delivery': {
      join();
      const first = add(act(), 'viewer-1', 'ACCEPTED');
      const key = `step-${steps.length + 1}`;
      steps.push({ kind: 'chat', key, event: { ...first, roles: [...first.roles], at: ++clock } });
      expectations.push({ id: key, stepKey: key, kind: 'decision', value: 'DUPLICATE' });
      break;
    }
    case 'late-arrival':
      join();
      add(act());
      advance(definition ? Math.floor(definition.durationMs / 2) : statelessWindowMs + clock);
      join('late-viewer');
      add(
        act(1),
        'late-viewer',
        definition && format && slotAt(definition, clock).reveal
          ? 'ANSWER_CLOSED'
          : mechanics && hitsToEliminate <= 1
            ? undefined
            : reachesGoal(1)
              ? 'SESSION_FINISHED'
              : definition?.maxParticipants === 1
                ? definition.teams.length
                  ? 'NOT_JOINED'
                  : 'PARTICIPANT_LIMIT'
                : 'ACCEPTED',
      );
      break;
    case 'exhaustion': {
      if (definition && format && format.kind !== 'mural') {
        // One choice per stage or question: a second choice in the same window is refused.
        add(act(0), 'viewer-1', 'ACCEPTED');
        add(act(1), 'viewer-1', 'ALREADY_CHOSEN');
        break;
      }
      if (definition && format?.kind === 'mural') {
        const allowance = definition.resource.perParticipant;
        const cells = format.width * format.height;
        for (let i = 0; i <= allowance; i++)
          add(
            act(i),
            'viewer-1',
            i === allowance && (format.overwrite || allowance < cells)
              ? 'RESOURCE_LIMIT'
              : undefined,
          );
        break;
      }
      join();
      const allowance = definition?.resource.perParticipant ?? manifest.trigger.maxPerViewer;
      for (let i = 0; i <= allowance; i++)
        add(
          manifest.trigger.command,
          'viewer-1',
          i === allowance && definition && !unsafeV2(allowance)
            ? reachesGoal(allowance)
              ? 'SESSION_FINISHED'
              : 'RESOURCE_LIMIT'
            : undefined,
        );
      break;
    }
    case 'deadline':
      join();
      add(act());
      advance(definition?.durationMs ?? statelessWindowMs + clock);
      add(
        act(),
        'viewer-1',
        !definition
          ? 'ACCEPTED'
          : unsafeV2(1)
            ? undefined
            : mechanics?.match
              ? mechanics.match.intermissionMs > 0
                ? 'ROUND_INTERMISSION'
                : 'ACCEPTED'
              : 'SESSION_FINISHED',
      );
      break;
    case 'burst': {
      const burst = mechanics?.burst;
      if (!definition || !burst) throw inapplicable('a burst rule');
      const text = burst.command ?? manifest.trigger.command;
      const viewers = Array.from({ length: burst.participants }, (_, i) => `viewer-${i + 1}`);
      for (const viewer of viewers) join(viewer);
      for (const [i, viewer] of viewers.entries()) {
        const last = i === viewers.length - 1;
        if (last && burst.command) add(text, 'viewer-1', 'BURST_COUNTED');
        // Counting contributions can end the round before the burst fills; then skip the check.
        add(text, viewer, last && (burst.command || !unsafeV2(i)) ? 'ACCEPTED' : undefined);
      }
      break;
    }
    case 'elimination': {
      const teams = definition?.teams ?? [];
      if (!definition || !health) throw inapplicable('a health rule');
      const allowance = definition.resource.perParticipant;
      if (
        hitsToEliminate > 80 ||
        Math.ceil(hitsToEliminate / allowance) + 1 > definition.maxParticipants
      )
        throw new RehearsalError(
          'INVALID_SCENARIO',
          'Elimination needs more synthetic contributions than one rehearsal holds.',
        );
      const enemy = teams[1];
      if (enemy) add(enemy.joinCommand, 'enemy');
      const burstEnds = definition.objective.kind === 'burst' && mechanics?.burst?.command === null;
      for (let hit = 0; hit < hitsToEliminate; hit++) {
        const viewer = `viewer-${Math.floor(hit / allowance) + 1}`;
        if (hit % allowance === 0) join(viewer);
        add(
          manifest.trigger.command,
          viewer,
          hit === hitsToEliminate - 1 && !burstEnds ? 'ACCEPTED' : undefined,
        );
      }
      add(
        manifest.trigger.command,
        'enemy',
        burstEnds
          ? undefined
          : teams.length > 2
            ? 'ELIMINATED'
            : mechanics?.match
              ? mechanics.match.intermissionMs > 0
                ? 'ROUND_INTERMISSION'
                : 'ACCEPTED'
              : 'SESSION_FINISHED',
      );
      break;
    }
    case 'match': {
      const match = mechanics?.match;
      if (!definition || !match) throw inapplicable('a best-of-N match');
      join();
      add(manifest.trigger.command, 'viewer-1', 'ACCEPTED');
      advance(definition.durationMs);
      if (match.intermissionMs > 0)
        add(manifest.trigger.command, 'viewer-1', after('ROUND_INTERMISSION', 1));
      advance(definition.durationMs + match.intermissionMs + 1);
      add(manifest.trigger.command, 'viewer-1', after('ACCEPTED', 1));
      const end = match.rounds * (definition.durationMs + match.intermissionMs);
      advance(end);
      expectations.push({
        id: `step-${steps.length}`,
        stepKey: `step-${steps.length}`,
        kind: 'phase',
        value: 'finished',
      });
      break;
    }
    case 'unlock': {
      const milestone = mechanics?.milestones.find((x) => x.unlock);
      if (!definition || !milestone?.unlock) throw inapplicable('an unlockable milestone');
      const needed = Math.ceil(milestone.score / definition.contribution.points);
      const allowance = definition.resource.perParticipant;
      if (needed > 80)
        throw new RehearsalError(
          'INVALID_SCENARIO',
          'Reaching this milestone needs more synthetic contributions than one rehearsal holds.',
        );
      join();
      add(milestone.unlock.command, 'viewer-1', 'LOCKED');
      let viewer = 'viewer-1';
      for (let i = 0; i < needed; i++) {
        viewer = `viewer-${Math.floor(i / allowance) + 1}`;
        if (i > 0 && i % allowance === 0) join(viewer);
        add(manifest.trigger.command, viewer);
      }
      const spender = `viewer-${Math.floor(needed / allowance) + 1}`;
      if (spender !== viewer || needed % allowance === 0) join(spender);
      add(milestone.unlock.command, spender, unsafeV2(needed) ? undefined : 'ACCEPTED');
      break;
    }
    case 'paint': {
      if (!definition || format?.kind !== 'mural') throw inapplicable('a mural');
      const cmd = definition.contribution.command;
      const [first = 'red', second = first] = format.palette;
      add(`${cmd} a1 ${first}`, 'viewer-1', 'ACCEPTED');
      add(`${cmd} a1 ${second}`, 'viewer-2', format.overwrite ? 'ACCEPTED' : 'CELL_TAKEN');
      add(`${cmd} a1 rainbow`, 'viewer-2', 'INVALID_CHOICE');
      add(`${cmd} b1 ${second}`, 'viewer-3', 'ACCEPTED');
      finishPhase();
      break;
    }
    case 'stages': {
      if (!definition || format?.kind !== 'composition') throw inapplicable('a staged vote');
      const w = slotMs(definition);
      for (const [i, stage] of format.stages.entries()) {
        if (i > 0) advance(i * w);
        const cmd = definition.contribution.command;
        add(`${cmd} ${stage.options[0]?.id ?? ''}`, 'viewer-1', 'ACCEPTED');
        add(`${cmd} ${stage.options[1]?.id ?? ''}`, 'viewer-2', 'ACCEPTED');
        if (i === 0) add(`${cmd} ${stage.options[1]?.id ?? ''}`, 'viewer-1', 'ALREADY_CHOSEN');
      }
      finishPhase();
      break;
    }
    case 'answers': {
      if (!definition || format?.kind !== 'quiz') throw inapplicable('a quiz');
      const w = slotMs(definition);
      const letters = ['!a', '!b', '!c', '!d'];
      for (const [i, question] of format.questions.entries()) {
        if (i > 0) advance(i * w);
        add(letters[question.answer] ?? '!a', 'viewer-1', 'ACCEPTED');
        add(letters[question.answer === 0 ? 1 : 0] ?? '!b', 'viewer-2', 'ACCEPTED');
        if (format.revealMs > 0) {
          advance(i * w + w - format.revealMs);
          add('!a', 'viewer-3', 'ANSWER_CLOSED');
        }
      }
      finishPhase();
      break;
    }
  }
  function inapplicable(what: string) {
    return new RehearsalError('INVALID_SCENARIO', `This interaction has no ${what} to rehearse.`);
  }
  return rehearsalScenarioSchema.parse({
    version: 1,
    seed,
    initialAt: 0,
    initialSession: null,
    steps,
    expectations,
    provenance: { kind: 'synthetic' },
  });
}
