import { z } from 'zod';
import type { ChatEvent, DecisionCode } from '@riff/sdk';
import { artifactSchema } from './contract.js';
import {
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
] as const;
export type RehearsalPreset = (typeof REHEARSAL_PRESETS)[number];
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
    const event = {
      id: `${preset}-${key}`,
      channelId: 'rehearsal',
      viewerId,
      roles: [...roles],
      text,
      at: ++clock,
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
  switch (preset) {
    case 'proof':
      add('unrelated rehearsal message', 'noise', 'UNRELATED');
      add(manifest.trigger.command, 'ineligible', 'AUDIENCE', []);
      join();
      add(manifest.trigger.command, 'viewer-1', 'ACCEPTED');
      break;
    case 'crowd-burst':
      for (let i = 0; i < Math.min(40, definition?.maxParticipants ?? 40); i++) {
        const viewer = `viewer-${i + 1}`;
        join(viewer);
        add(manifest.trigger.command, viewer);
      }
      break;
    case 'duplicate-delivery': {
      join();
      const first = add(manifest.trigger.command, 'viewer-1', 'ACCEPTED');
      const key = `step-${steps.length + 1}`;
      steps.push({ kind: 'chat', key, event: { ...first, roles: [...first.roles], at: ++clock } });
      expectations.push({ id: key, stepKey: key, kind: 'decision', value: 'DUPLICATE' });
      break;
    }
    case 'late-arrival':
      join();
      add(manifest.trigger.command);
      advance(definition ? Math.floor(definition.durationMs / 2) : statelessWindowMs + clock);
      join('late-viewer');
      add(
        manifest.trigger.command,
        'late-viewer',
        reachesGoal(1)
          ? 'SESSION_FINISHED'
          : definition?.maxParticipants === 1
            ? definition.teams.length
              ? 'NOT_JOINED'
              : 'PARTICIPANT_LIMIT'
            : 'ACCEPTED',
      );
      break;
    case 'exhaustion': {
      join();
      const allowance = definition?.resource.perParticipant ?? manifest.trigger.maxPerViewer;
      for (let i = 0; i <= allowance; i++)
        add(
          manifest.trigger.command,
          'viewer-1',
          i === allowance && definition
            ? reachesGoal(allowance)
              ? 'SESSION_FINISHED'
              : 'RESOURCE_LIMIT'
            : undefined,
        );
      break;
    }
    case 'deadline':
      join();
      add(manifest.trigger.command);
      advance(definition?.durationMs ?? statelessWindowMs + clock);
      add(manifest.trigger.command, 'viewer-1', definition ? 'SESSION_FINISHED' : 'ACCEPTED');
      break;
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
