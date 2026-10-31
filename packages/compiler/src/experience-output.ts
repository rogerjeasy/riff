import {
  SDK_VERSION,
  type AudienceRole,
  type ExperienceDefinition,
  type Scenario,
  type ScenarioStep,
} from '@riff/sdk';
import type { CompileOutput, CompileRequest } from './contract.js';
import { extractExperienceHints } from './experience-hints.js';

const RESERVED_TEAM_IDS = ['__proto__', 'constructor', 'prototype', 'community', 'tie'];
import {
  describeAudience,
  describeWindow,
  extractIntentHints,
  type ManifestView,
} from './intent.js';

const COMPLEX_MECHANICS =
  /\b(?:health|damage|eliminat\w*|inventor\w*|unlock\w*|levels?|steal\w*|trades?|purchases?|bets?|wagers?|random (?:winner|scores?)|multiple rounds?|best of|brackets?|tournaments?|lives|respawn\w*|cooldowns?)\b/i;

const empty = {
  question: null,
  choices: [],
  unsupportedReason: null,
  alternative: null,
  source: null,
  manifest: null,
  tests: [],
  behavior: { when: '', what: '', who: '', howMuch: '' },
  assumptions: [],
};

/** Offline templates deliberately cover bounded score rounds, not arbitrary game mechanics. */
export function compileExperienceOffline(request: CompileRequest): CompileOutput | null {
  const hints = extractExperienceHints(request.intent);
  const base = request.base?.manifest as ManifestView | undefined;
  const previous = base?.experience;

  const unsupported = (reason: string): CompileOutput => ({
    ...empty,
    kind: 'unsupported',
    title: 'Unsupported Offline Rules',
    summary: 'The offline template compiler cannot faithfully generate these rules.',
    unsupportedReason: reason,
    alternative:
      'Use a bounded team score battle or a cooperative contribution goal, or switch to model compilation for other supported SDK rules.',
  });
  if (COMPLEX_MECHANICS.test(request.intent))
    return unsupported(
      'These mechanics are outside the bounded team-score and collective-goal session primitives.',
    );
  if (!hints.requested && !previous) return null;
  const kind = hints.objective ?? previous?.objective.kind;
  if (!kind)
    return unsupported(
      'Choose a highest-score team battle or a cooperative collective goal. The offline compiler does not infer other session rules.',
    );
  const assumptions = ['Offline template compiler; no model call.'];
  // "join red or blue" names teams without commands; derive !red/!blue and say so.
  const derived = hints.teamNames?.map((name) => ({
    id: name,
    label: name.charAt(0).toUpperCase() + name.slice(1),
    joinCommand: `!${name}`,
  }));
  const derivable =
    derived?.length &&
    derived.length <= 8 &&
    derived.every(
      (team) => /^[a-z0-9_-]{1,31}$/.test(team.id) && !RESERVED_TEAM_IDS.includes(team.id),
    );
  if (derivable)
    assumptions.push(
      `Teams join with ${derived.map((team) => team.joinCommand).join(' or ')}, named after the teams.`,
    );
  const teams = hints.teams ?? (derivable ? derived : null) ?? previous?.teams ?? [];
  if (kind === 'highest-score' && !teams.length)
    return {
      ...empty,
      kind: 'question',
      title: 'Which Teams?',
      summary: 'A team battle needs explicit teams.',
      question: 'Which teams and join commands should the battle use?',
      choices: ['Red with !red and Blue with !blue'],
    };
  if (hints.teamCount !== null && hints.teamCount !== teams.length)
    return unsupported(
      'The stated number of teams does not match the explicit team join commands.',
    );
  const fallbackCommand = kind === 'highest-score' ? '!throw' : '!grow';
  const command = hints.command ?? previous?.contribution.command ?? fallbackCommand;
  if (!hints.command && !previous)
    assumptions.push(`Participants contribute with ${fallbackCommand}.`);
  if (teams.some((team) => team.joinCommand === command))
    return unsupported('The contribution command must differ from every team join command.');
  const facts = extractIntentHints(request.intent);
  function pick<T>(stated: T | null, old: T | undefined, fallback: T, note: string): T {
    if (stated !== null) return stated;
    if (old !== undefined) return old;
    assumptions.push(note);
    return fallback;
  }
  const definition: ExperienceDefinition = {
    version: 1,
    title: request.base?.title ?? (kind === 'highest-score' ? 'Tomato Battle' : 'Community Goal'),
    durationMs: pick(
      hints.durationMs,
      previous?.durationMs,
      120000,
      'The round lasts 120 seconds.',
    ),
    maxParticipants: previous?.maxParticipants ?? 256,
    teams,
    resource: {
      name:
        hints.resourceName ??
        previous?.resource.name ??
        (kind === 'highest-score' ? 'throws' : 'contributions'),
      perParticipant: pick(
        hints.perParticipant,
        previous?.resource.perParticipant,
        3,
        'Each participant gets 3 actions per round.',
      ),
    },
    contribution: { command, points: previous?.contribution.points ?? 1 },
    objective: {
      kind,
      target:
        kind === 'highest-score'
          ? null
          : pick(
              hints.target,
              previous?.objective.target ?? undefined,
              5,
              'The collective goal is 5 points.',
            ),
    },
  };
  if (!previous) assumptions.push('Up to 256 participants; each contribution adds 1 point.');
  const audience = facts.audience ?? base?.trigger.audience ?? ['viewer'];
  const asset =
    facts.asset ??
    (request.base
      ? (['tomato', 'star', 'heart'] as const).find((value) =>
          request.base?.source.includes(`'${value}'`),
        )
      : undefined) ??
    (kind === 'highest-score' ? 'tomato' : 'heart');
  return {
    ...empty,
    kind: 'candidate',
    title: definition.title,
    summary:
      kind === 'highest-score'
        ? `Join a team and use ${command} to score during a timed battle.`
        : `Use ${command} to help the community reach ${definition.objective.target} points.`,
    source: `async (event, riff) => {\n  const snapshot = riff.session.snapshot();\n  await riff.overlay.emit({ kind: 'projectile', asset: '${asset}', x: snapshot.revision % 2 === 0 ? 0.25 : 0.75 });\n}`,
    manifest: {
      sdkVersion: SDK_VERSION,
      capabilities: ['overlay', 'session'],
      trigger: {
        command,
        audience,
        maxPerViewer: definition.resource.perParticipant,
        windowMs: definition.durationMs,
      },
      limits: { effectsPerEvent: 1, effectsPerMinute: 120 },
      experience: definition,
    },
    tests: experienceScenarios(definition, audience),
    behavior: {
      when: teams.length
        ? `Join ${teams.map((team) => `${team.label} with ${team.joinCommand}`).join(' or ')}; contribute with ${command}`
        : `Type ${command} to join and contribute`,
      what:
        kind === 'highest-score'
          ? 'Team scores accumulate; the highest score wins at the deadline'
          : `Everyone builds toward ${definition.objective.target} points; reaching the goal ends the round`,
      who: `${describeAudience(audience)}; up to ${definition.maxParticipants} participants`,
      howMuch: `${definition.resource.perParticipant} ${definition.resource.name} per participant per round; ${describeWindow(definition.durationMs)} duration`,
    },
    assumptions,
  };
}

function experienceScenarios(
  definition: ExperienceDefinition,
  audience: AudienceRole[],
): Scenario[] {
  const roles: AudienceRole[] = audience.includes('viewer')
    ? ['viewer']
    : [audience[0] ?? 'broadcaster', 'viewer'];
  const command = definition.contribution.command;
  const firstTeam = definition.teams[0];
  const scoreKey = firstTeam?.id ?? 'community';
  const s = (
    id: string,
    viewer: string,
    text: string,
    at: number,
    expect: ScenarioStep['expect'],
    effects: number,
    session?: ScenarioStep['session'],
  ): ScenarioStep => ({
    id,
    viewer,
    roles,
    text,
    at,
    expect,
    effects,
    ...(session ? { session } : {}),
  });
  const join = (viewer = 'alice', id = 'join'): ScenarioStep[] =>
    firstTeam ? [s(id, viewer, firstTeam.joinCommand, 0, 'ACCEPTED', 0)] : [];
  const allowance = definition.resource.perParticipant;
  const limitSteps = [
    ...join(),
    ...Array.from({ length: allowance }, (_, i) =>
      s(`spend${i}`, 'alice', command, i + 1, 'ACCEPTED', 1),
    ),
    s('over', 'alice', command, allowance + 1, 'RESOURCE_LIMIT', 0, {
      participants: { alice: { remaining: 0, contributions: allowance } },
    }),
  ];
  // For a cooperative goal smaller than one allowance, the goal ends before exhaustion.
  const canExhaust =
    definition.objective.kind === 'highest-score' ||
    (definition.objective.target ?? 0) > allowance * definition.contribution.points;
  const list: Scenario[] = [
    {
      name: 'A contribution consumes one resource and adds points',
      kind: 'happy',
      steps: [
        ...join(),
        s('first', 'alice', command, 1, 'ACCEPTED', 1, {
          scores: { [scoreKey]: definition.contribution.points },
          participants: { alice: { remaining: allowance - 1, contributions: 1 } },
        }),
      ],
    },
    {
      name: 'Ordinary chat does not contribute',
      kind: 'negative',
      steps: [s('unrelated', 'alice', 'hello chat', 0, 'UNRELATED', 0)],
    },
    {
      name: 'Redelivered contributions never score twice',
      kind: 'duplicate',
      steps: [
        ...join(),
        s('same', 'alice', command, 1, 'ACCEPTED', 1),
        s('same', 'alice', command, 2, 'DUPLICATE', 0, {
          scores: { [scoreKey]: definition.contribution.points },
        }),
      ],
    },
    {
      name: 'The exact deadline ends the round',
      kind: 'limit',
      steps: [
        ...join(),
        s('deadline', 'bob', command, definition.durationMs, 'SESSION_FINISHED', 0, {
          phase: 'finished',
        }),
      ],
    },
  ];
  if (canExhaust && allowance <= 22)
    list.push({ name: 'Resources never renew during a round', kind: 'limit', steps: limitSteps });
  if (definition.objective.kind === 'collective-goal') {
    const n = Math.ceil((definition.objective.target ?? 0) / definition.contribution.points);
    if (n <= 22)
      list.push({
        name: 'The collective goal ends the round early',
        kind: 'happy',
        steps: [
          ...Array.from({ length: n }, (_, i) =>
            s(
              `goal${i}`,
              `viewer${Math.floor(i / allowance)}`,
              command,
              i,
              'ACCEPTED',
              1,
              i === n - 1
                ? { phase: 'finished', scores: { community: n * definition.contribution.points } }
                : undefined,
            ),
          ),
          s('after-goal', 'late', command, n, 'SESSION_FINISHED', 0),
        ],
      });
  }
  return list;
}
