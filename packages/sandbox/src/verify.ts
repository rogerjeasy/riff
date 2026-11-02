import ts from 'typescript';
import {
  CAPABILITIES,
  type AudienceRole,
  type Capability,
  type DecisionCode,
  type ExecutionDecision,
  type PermissionManifest,
  type Scenario,
  type SessionSnapshot,
  type SessionAssertion,
  type TimerAssertion,
  type TwitchEventDetail,
} from '@riff/sdk';
import { artifactSchema, manifestSchema, scenariosSchema } from './contract.js';
import { artifactIdentity, createEngine, matchesCommand } from './engine.js';
import { createSessionSnapshot } from './session.js';
import { instrumentHandler } from './instrument.js';
import { createVirtualTimers } from './timers.js';
import { mechanicsHostScenarios } from './mechanics-suite.js';

export type StageId = 'manifest' | 'static' | 'compile' | 'generated' | 'host';
export type StageStatus = 'passed' | 'failed' | 'skipped';
export interface Finding {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
  line: number | null;
}
export interface StepResult {
  session?: SessionSnapshot;
  expectSession?: SessionAssertion;
  /** Timer fires delivered on the virtual clock before this step, and their effects. */
  timers?: TimerAssertion;
  expectTimers?: TimerAssertion;
  id: string;
  viewer: string;
  roles: AudienceRole[];
  text: string;
  /** Synthetic Twitch event for event-trigger steps (F19). */
  twitch?: TwitchEventDetail;
  at: number;
  kind?: 'points.redeem';
  expect: DecisionCode;
  expectEffects: number | null;
  actual: DecisionCode;
  actualEffects: number;
  passed: boolean;
}
export interface ScenarioResult {
  name: string;
  kind: string;
  origin: 'generated' | 'host';
  passed: boolean;
  steps: StepResult[];
  durationMs: number;
}
export interface StageReport {
  id: StageId;
  label: string;
  status: StageStatus;
  durationMs: number;
  summary: string;
}
export interface VerificationReport {
  ok: boolean;
  artifactId: string | null;
  stages: StageReport[];
  findings: Finding[];
  capabilitiesUsed: Capability[];
  generated: ScenarioResult[];
  host: ScenarioResult[];
  /** Compact failure text suitable for a single repair round (≤ 4 KB). */
  failureReport: string | null;
}

const FORBIDDEN_IDENTIFIERS = new Map([
  ['eval', 'Dynamic evaluation is not available'],
  ['Function', 'Dynamic code construction is not available'],
  ['require', 'Modules are not available; use only the riff bridge'],
  ['globalThis', 'Global mutation is not available'],
  ['Date', 'Use riff.util.now() for time'],
  ['fetch', 'Network access is not available'],
  ['XMLHttpRequest', 'Network access is not available'],
  ['WebSocket', 'Network access is not available'],
  ['setTimeout', 'Use riff.timer.start for a host-owned named timer'],
  ['setInterval', 'Use riff.timer.start with { repeat: true } for a host-owned timer'],
  ['process', 'Host process access is not available'],
]);

/** Restricted-syntax and least-privilege analysis of a handler expression. */
export function analyzeSource(source: string, manifest: PermissionManifest) {
  const findings: Finding[] = [];
  const used = new Set<Capability>();
  const file = ts.createSourceFile(
    'handler.js',
    `(${source})`,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  const line = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const add = (severity: Finding['severity'], rule: string, message: string, node?: ts.Node) =>
    findings.push({ severity, rule, message, line: node ? line(node) : null });
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || node.kind === ts.SyntaxKind.ImportKeyword)
      add('error', 'no-import', 'Imports are not available inside a handler', node);
    if (ts.isWithStatement(node)) add('error', 'no-with', '`with` is not allowed', node);
    if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.has(node.text)) {
      const parent = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isPropertyName)
        add('error', 'no-ambient', FORBIDDEN_IDENTIFIERS.get(node.text) ?? 'Not allowed', node);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'random' &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Math'
    )
      add('error', 'no-ambient', 'Use riff.util.random() for deterministic randomness', node);
    if (
      (ts.isWhileStatement(node) || ts.isDoStatement(node)) &&
      node.expression.kind === ts.SyntaxKind.TrueKeyword
    )
      add('error', 'bounded-loops', 'Unbounded loops are not allowed', node);
    if (ts.isForStatement(node) && !node.condition)
      add('error', 'bounded-loops', 'Loops need an explicit bound', node);
    if (ts.isRegularExpressionLiteral(node) && node.text.length > 200)
      add('error', 'small-literals', 'Regular expressions are limited to 200 characters', node);
    if (ts.isStringLiteralLike(node) && node.text.length > 500)
      add('error', 'small-literals', 'String literals are limited to 500 characters', node);
    if (ts.isPropertyAccessExpression(node)) {
      // Dotted capabilities (`chat.announce`) are matched on the full member chain.
      const dotted = ts.isPropertyAccessExpression(node.expression)
        ? `${node.expression.name.text}.${node.name.text}`
        : null;
      if (dotted && CAPABILITIES.includes(dotted as Capability)) used.add(dotted as Capability);
      else if (CAPABILITIES.includes(node.name.text as Capability))
        used.add(node.name.text as Capability);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  try {
    instrumentHandler(source);
  } catch (error) {
    add('error', 'handler-shape', error instanceof Error ? error.message : 'Invalid handler');
  }
  for (const capability of used)
    if (!manifest.capabilities.includes(capability))
      add('error', 'declared-capabilities', `Uses \`${capability}\` without declaring it`);
  for (const capability of manifest.capabilities)
    if (!used.has(capability))
      add('warning', 'least-privilege', `Declares \`${capability}\` but never uses it`);
  return { findings, capabilitiesUsed: [...used] };
}

/** Effects plus staged native Twitch actions: what a scenario step's `effects` counts. */
export function outputCount(decision: Pick<ExecutionDecision, 'effects' | 'actions'>): number {
  return decision.effects.length + (decision.actions?.length ?? 0);
}

/** Run declarative scenarios through fresh preview engines, one engine per scenario. */
export async function runScenarios(
  artifact: { source: string; manifest: PermissionManifest },
  scenarios: Scenario[],
  origin: 'generated' | 'host',
  seed = 7,
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const started = performance.now();
    // Each scenario owns a fresh virtual timer store on the scenario clock.
    const timers = createVirtualTimers('verification');
    const engine = createEngine(artifact, {
      seed,
      mode: 'preview',
      timers,
      ...(artifact.manifest.experience
        ? { session: createSessionSnapshot(artifact.manifest.experience, 0) }
        : {}),
    });
    const steps: StepResult[] = [];
    try {
      for (const step of scenario.steps) {
        const advanced = await timers.advance(engine, step.at);
        const fired = {
          fired: advanced.fires.length,
          effects: advanced.fires.reduce((sum, fire) => sum + fire.decision.effects.length, 0),
        };
        const decision = await engine.dispatch({
          id: step.id,
          channelId: 'verification',
          viewerId: step.viewer,
          roles: step.roles,
          text: step.text,
          at: step.at,
          ...(step.kind ? { kind: step.kind } : {}),
          ...(step.twitch ? { twitch: step.twitch } : {}),
        });
        timers.apply(decision);
        const expectEffects = step.effects;
        const timersMatch =
          !step.timers ||
          (step.timers.fired === fired.fired && step.timers.effects === fired.effects);
        const actual = outputCount(decision);
        const passed =
          timersMatch &&
          matchesSessionAssertion(decision.session, step.session) &&
          decision.code === step.expect &&
          (expectEffects === -2 || (expectEffects < 0 ? actual > 0 : actual === expectEffects));
        steps.push({
          id: step.id,
          viewer: step.viewer,
          roles: step.roles,
          text: step.text,
          ...(step.twitch ? { twitch: step.twitch } : {}),
          at: step.at,
          ...(step.kind ? { kind: step.kind } : {}),
          expect: step.expect,
          expectEffects: expectEffects < 0 ? null : expectEffects,
          ...(decision.session ? { session: decision.session } : {}),
          ...(step.session ? { expectSession: step.session } : {}),
          ...(fired.fired || step.timers ? { timers: fired } : {}),
          ...(step.timers ? { expectTimers: step.timers } : {}),
          actual: decision.code,
          actualEffects: actual,
          passed,
        });
      }
    } finally {
      engine.stop();
    }
    results.push({
      name: scenario.name,
      kind: scenario.kind,
      origin,
      passed: steps.every((step) => step.passed),
      steps,
      durationMs: Math.round(performance.now() - started),
    });
  }
  return results;
}

/**
 * The host's own acceptance suite, derived only from the manifest. Generated code and
 * generated tests cannot edit it. `effects: -1` means "at least one effect";
 * internal session steps use -2 to check semantic state with any effect count.
 */
export function hostScenarios(manifest: PermissionManifest): Scenario[] {
  if (manifest.experience?.mechanics) return mechanicsHostScenarios(manifest);
  if (manifest.experience) return sessionHostScenarios(manifest);
  if (manifest.trigger.kind === 'points.redeem') return redemptionHostScenarios(manifest);
  if (manifest.trigger.kind === 'twitch.event') return eventHostScenarios(manifest);
  const { command, audience, maxPerViewer, windowMs } = manifest.trigger;
  // Proposal-only handlers emit no overlay effect: assert admission, not effect count.
  const produced = manifest.capabilities.includes('overlay') ? -1 : -2;
  const eligible: AudienceRole[] = audience.includes('viewer')
    ? ['viewer']
    : [audience[0] ?? 'broadcaster', 'viewer'];
  // A timer interaction may only schedule on chat and show effects when the timer fires,
  // so accepted chat steps assert admission with any effect count (-2).
  const anyEffects = manifest.capabilities.includes('timer');
  const step = (
    id: string,
    viewer: string,
    text: string,
    at: number,
    expect: DecisionCode,
    effects: number,
    roles = eligible,
  ) => ({ id, viewer, roles, text, at, expect, effects: anyEffects && effects < 0 ? -2 : effects });
  const perEvent = manifest.limits.effectsPerEvent;
  const perMinute = manifest.limits.effectsPerMinute;
  // Only assert what the budget guarantees regardless of how many effects a call emits.
  const fitsBudget = maxPerViewer * perEvent <= perMinute;
  const otherFits = (maxPerViewer + 1) * perEvent <= perMinute;
  const scenarios: Scenario[] = [
    {
      name: `${command} from an eligible viewer produces an effect`,
      kind: 'happy',
      steps: [step('h1', 'ada', command, 0, 'ACCEPTED', produced)],
    },
    {
      name: 'Surrounding spaces and capitals still match; suffixes do not',
      kind: 'negative',
      steps: [
        step('h1', 'ada', `  ${command.toUpperCase()} `, 0, 'ACCEPTED', produced),
        step('h2', 'ben', `${command}s`, 1, 'UNRELATED', 0),
        step('h3', 'ben', `hello ${command}`, 2, 'UNRELATED', 0),
        step('h4', 'ben', 'hello chat', 3, 'UNRELATED', 0),
      ],
    },
    {
      name: 'A redelivered event never produces a second effect',
      kind: 'duplicate',
      steps: [
        step('h1', 'ada', command, 0, 'ACCEPTED', produced),
        step('h1', 'ada', command, 5, 'DUPLICATE', 0),
      ],
    },
  ];
  if (fitsBudget) {
    const steps = Array.from({ length: maxPerViewer }, (_, i) =>
      step(`a${i}`, 'ada', command, i, 'ACCEPTED', produced),
    );
    steps.push(step('over', 'ada', command, maxPerViewer, 'VIEWER_LIMIT', 0));
    if (otherFits)
      steps.push(step('other', 'ben', command, maxPerViewer + 1, 'ACCEPTED', produced));
    scenarios.push({
      name: `Viewer allowance: ${maxPerViewer} accepted, next blocked${otherFits ? ', another viewer unaffected' : ''}`,
      kind: 'limit',
      steps,
    });
    if (maxPerViewer <= 10 && otherFits)
      scenarios.push({
        name: 'Allowance returns when the rolling window passes',
        kind: 'window',
        steps: [
          ...Array.from({ length: maxPerViewer }, (_, i) =>
            step(`w${i}`, 'ada', command, i, 'ACCEPTED', produced),
          ),
          step('wover', 'ada', command, windowMs - 1, 'VIEWER_LIMIT', 0),
          step('wback', 'ada', command, Math.max(windowMs, 60_000), 'ACCEPTED', produced),
        ],
      });
  }
  if (!audience.includes('viewer'))
    scenarios.push({
      name: `Only ${audience.join(', ')} may trigger it`,
      kind: 'role',
      steps: [
        step('r1', 'cy', command, 0, 'AUDIENCE', 0, ['viewer']),
        step('r2', 'ada', command, 1, 'ACCEPTED', produced),
      ],
    });
  return scenarios;
}

/** Host suite for Channel Points triggers: redemptions only, dedupe, allowance, chat ignored. */
function redemptionHostScenarios(manifest: PermissionManifest): Scenario[] {
  const { command, maxPerViewer, windowMs } = manifest.trigger;
  const produced = manifest.capabilities.includes('overlay') ? -1 : -2;
  const redeem = (
    id: string,
    viewer: string,
    at: number,
    expect: DecisionCode,
    effects: number,
  ) => ({
    id,
    viewer,
    roles: ['viewer'] as AudienceRole[],
    text: '',
    at,
    expect,
    effects,
    kind: 'points.redeem' as const,
  });
  const scenarios: Scenario[] = [
    {
      name: 'A linked redemption produces the effect',
      kind: 'happy',
      steps: [redeem('h1', 'ada', 0, 'ACCEPTED', produced)],
    },
    {
      name: 'Chat never triggers a Channel Points interaction, even its handle',
      kind: 'negative',
      steps: [
        {
          id: 'c1',
          viewer: 'ada',
          roles: ['viewer'],
          text: command,
          at: 0,
          expect: 'UNRELATED',
          effects: 0,
        },
        {
          id: 'c2',
          viewer: 'ada',
          roles: ['broadcaster'],
          text: command,
          at: 1,
          expect: 'UNRELATED',
          effects: 0,
        },
      ],
    },
    {
      name: 'A redelivered redemption never produces a second effect',
      kind: 'duplicate',
      steps: [redeem('d1', 'ada', 0, 'ACCEPTED', produced), redeem('d1', 'ada', 5, 'DUPLICATE', 0)],
    },
  ];
  const perEvent = manifest.limits.effectsPerEvent;
  if (maxPerViewer * perEvent <= manifest.limits.effectsPerMinute && maxPerViewer <= 20) {
    const steps = Array.from({ length: maxPerViewer }, (_, i) =>
      redeem(`a${i}`, 'ada', i, 'ACCEPTED', produced),
    );
    steps.push(redeem('over', 'ada', maxPerViewer, 'VIEWER_LIMIT', 0));
    scenarios.push({
      name: `Viewer allowance: ${maxPerViewer} redemptions per ${windowMs} ms, the next is refused (and refunded by the host)`,
      kind: 'limit',
      steps,
    });
  }
  return scenarios;
}

/** Synthetic Twitch event detail for host and offline scenarios. Example: syntheticTwitchEvent('cheer', 100). */
export function syntheticTwitchEvent(
  kind: TwitchEventDetail['kind'],
  amount: number,
  options: { anonymous?: boolean; gift?: boolean } = {},
): TwitchEventDetail {
  const subscription = kind === 'subscribe' || kind === 'gift' || kind === 'resub';
  return {
    kind,
    amount: kind === 'subscribe' ? 1 : Math.max(1, Math.trunc(amount)),
    tier: subscription ? '1000' : null,
    anonymous: Boolean(options.anonymous) && (kind === 'gift' || kind === 'cheer'),
    gift: Boolean(options.gift) && kind === 'subscribe',
  };
}

/**
 * Host suite for F19 event triggers: the matching event admits, chat and other kinds
 * are unrelated, amounts below the minimum never run the handler, redeliveries are
 * ignored and the per-viewer allowance holds for events too.
 */
function eventHostScenarios(manifest: PermissionManifest): Scenario[] {
  if (manifest.trigger.kind !== 'twitch.event') return [];
  const event = manifest.trigger.event;
  const { maxPerViewer } = manifest.trigger;
  const other = event.kind === 'raid' ? 'cheer' : 'raid';
  const step = (
    id: string,
    viewer: string,
    twitch: TwitchEventDetail | null,
    at: number,
    expect: DecisionCode,
    effects: number,
    text = '',
  ): Scenario['steps'][number] => ({
    id,
    viewer,
    roles: ['viewer'],
    text,
    at,
    expect,
    effects,
    ...(twitch ? { twitch } : {}),
  });
  const hit = () => syntheticTwitchEvent(event.kind, event.minimum);
  const perEvent = manifest.limits.effectsPerEvent;
  const scenarios: Scenario[] = [
    {
      name: `A ${event.kind} at the minimum produces an effect`,
      kind: 'happy',
      steps: [step('e1', 'ada', hit(), 0, 'ACCEPTED', -1)],
    },
    {
      name: 'Chat messages and other Twitch events do nothing',
      kind: 'negative',
      steps: [
        step('n1', 'ben', null, 0, 'UNRELATED', 0, manifest.trigger.command),
        step('n2', 'ben', null, 1, 'UNRELATED', 0, 'hello chat'),
        step('n3', 'ben', syntheticTwitchEvent(other, 1_000), 2, 'UNRELATED', 0),
      ],
    },
    {
      name: 'A redelivered Twitch event never produces a second effect',
      kind: 'duplicate',
      steps: [
        step('d1', 'ada', hit(), 0, 'ACCEPTED', -1),
        step('d1', 'ada', hit(), 5, 'DUPLICATE', 0),
      ],
    },
  ];
  if (event.minimum > 1 && event.kind !== 'subscribe')
    scenarios.push({
      name: `Below ${event.minimum} does not run the handler`,
      kind: 'limit',
      steps: [
        step(
          'b1',
          'ada',
          syntheticTwitchEvent(event.kind, event.minimum - 1),
          0,
          'BELOW_MINIMUM',
          0,
        ),
        step('b2', 'ada', hit(), 1, 'ACCEPTED', -1),
      ],
    });
  if (maxPerViewer * perEvent <= manifest.limits.effectsPerMinute && maxPerViewer <= 20) {
    const steps = Array.from({ length: maxPerViewer }, (_, i) =>
      step(`a${i}`, 'ada', hit(), i, 'ACCEPTED', -1),
    );
    steps.push(step('over', 'ada', hit(), maxPerViewer, 'VIEWER_LIMIT', 0));
    scenarios.push({
      name: `Event allowance: ${maxPerViewer} per viewer, next blocked`,
      kind: 'limit',
      steps,
    });
  }
  return scenarios;
}

/** Compare only the declared canonical state fields. Example: matchesSessionAssertion(state, {scores:{red:2}}). */
export function matchesSessionAssertion(
  actual: SessionSnapshot | undefined,
  expected: SessionAssertion | null | undefined,
): boolean {
  if (!expected) return true;
  if (!actual) return false;
  if (expected.phase !== undefined && actual.phase !== expected.phase) return false;
  if (expected.remainingMs !== undefined && actual.remainingMs !== expected.remainingMs)
    return false;
  for (const [key, score] of Object.entries(expected.scores ?? {}))
    if (!Object.hasOwn(actual.scores, key) || actual.scores[key] !== score) return false;
  if (expected.round !== undefined && actual.mechanics?.round !== expected.round) return false;
  if (expected.winner !== undefined && actual.winner !== expected.winner) return false;
  for (const [key, wins] of Object.entries(expected.wins ?? {}))
    if (!actual.mechanics || actual.mechanics.wins[key] !== wins) return false;
  for (const [key, standing] of Object.entries(expected.standings ?? {})) {
    const found = actual.mechanics?.standings[key];
    if (!found || !Object.hasOwn(actual.mechanics?.standings ?? {}, key)) return false;
    if (standing.health !== undefined && found.health !== standing.health) return false;
    if (standing.eliminated !== undefined && found.eliminated !== standing.eliminated) return false;
    if (standing.bursts !== undefined && found.bursts !== standing.bursts) return false;
    if (standing.tier !== undefined && found.unlocked.length !== standing.tier) return false;
  }
  for (const [key, participant] of Object.entries(expected.participants ?? {})) {
    if (!Object.hasOwn(actual.participants, key)) return false;
    const found = actual.participants[key];
    for (const [field, value] of Object.entries(participant))
      if (found?.[field as keyof typeof found] !== value) return false;
  }
  return true;
}
function sessionHostScenarios(manifest: PermissionManifest): Scenario[] {
  const d = manifest.experience;
  if (!d) return [];
  const eligible: AudienceRole[] = manifest.trigger.audience.includes('viewer')
    ? ['viewer']
    : [manifest.trigger.audience[0] ?? 'broadcaster', 'viewer'];
  const step = (
    id: string,
    viewer: string,
    text: string,
    at: number,
    expect: DecisionCode,
    effects: number,
    session?: SessionAssertion,
  ): Scenario['steps'][number] => ({
    id,
    viewer,
    text,
    at,
    roles: eligible,
    expect,
    effects,
    ...(session ? { session } : {}),
  });
  const command = d.contribution.command,
    team = d.teams[0],
    scoreKey = team?.id ?? 'community';
  const join = () =>
    team
      ? [
          step('join', 'ada', team.joinCommand, 0, 'ACCEPTED', 0, {
            participants: {
              ada: { remaining: d.resource.perParticipant, contributions: 0, teamId: team.id },
            },
          }),
        ]
      : [];
  const afterFirst = {
    scores: { [scoreKey]: d.contribution.points },
    participants: { ada: { remaining: d.resource.perParticipant - 1, contributions: 1 } },
  };
  const first = () => step('first', 'ada', command, 1, 'ACCEPTED', -2, afterFirst);
  const suite: Scenario[] = [
    {
      name: 'Session contribution updates canonical resources and score',
      kind: 'happy',
      steps: [...join(), first()],
    },
    {
      name: 'Session duplicate identity cannot score twice',
      kind: 'duplicate',
      steps: [...join(), first(), step('first', 'ada', command, 2, 'DUPLICATE', 0, afterFirst)],
    },
    {
      name: 'Session finishes before accepting a contribution at the exact deadline',
      kind: 'limit',
      steps: [
        ...join(),
        step('deadline', 'ada', command, d.durationMs, 'SESSION_FINISHED', 0, {
          phase: 'finished',
          scores: { [scoreKey]: 0 },
          remainingMs: 0,
        }),
      ],
    },
    {
      name: 'Session unrelated chat does not consume resources',
      kind: 'negative',
      steps: [
        ...join(),
        step('unrelated', 'ada', 'hello chat', 1, 'UNRELATED', 0, { scores: { [scoreKey]: 0 } }),
        first(),
      ],
    },
  ];
  if (team)
    suite.push({
      name: 'Session requires joining and keeps the chosen team',
      kind: 'role',
      steps: [
        step('before', 'ada', command, 0, 'NOT_JOINED', 0),
        ...join(),
        step('again', 'ada', d.teams[1]?.joinCommand ?? team.joinCommand, 1, 'ALREADY_JOINED', 0),
      ],
    });
  const steps = join();
  const target = d.objective.target ?? Infinity;
  let finished = false;
  for (let i = 0; i < d.resource.perParticipant; i++) {
    const score = (i + 1) * d.contribution.points;
    finished = score >= target;
    steps.push(
      step(`resource${i}`, 'ada', command, 1 + i, 'ACCEPTED', -2, {
        scores: { [scoreKey]: score },
        participants: {
          ada: { remaining: d.resource.perParticipant - i - 1, contributions: i + 1 },
        },
        phase: finished ? 'finished' : 'running',
      }),
    );
    if (finished) break;
  }
  steps.push(
    step(
      'blocked',
      'ada',
      command,
      Math.min(
        d.durationMs - 1,
        Math.max(1 + d.resource.perParticipant, manifest.trigger.windowMs),
      ),
      finished ? 'SESSION_FINISHED' : 'RESOURCE_LIMIT',
      0,
    ),
  );
  suite.push({
    name: finished
      ? 'Cooperative goal finishes as soon as the target is reached'
      : 'Session resources never renew in a rolling window',
    kind: 'limit',
    steps,
  });
  // Keep verification bounded independently of model-authored scenario sizes.
  const actionsToGoal = Math.ceil(target / d.contribution.points);
  if (
    d.objective.kind === 'collective-goal' &&
    actionsToGoal <= 24 &&
    actionsToGoal <= d.maxParticipants * d.resource.perParticipant
  ) {
    const goalSteps: Scenario['steps'] = [];
    for (let i = 0; i < actionsToGoal; i++) {
      const viewer = `goal${Math.floor(i / d.resource.perParticipant)}`;
      goalSteps.push(
        step(`goal${i}`, viewer, command, i, 'ACCEPTED', -2, {
          phase: i === actionsToGoal - 1 ? 'finished' : 'running',
          scores: { community: (i + 1) * d.contribution.points },
          participants: {
            [viewer]: {
              remaining: d.resource.perParticipant - (i % d.resource.perParticipant) - 1,
            },
          },
        }),
      );
    }
    goalSteps.push(
      step('aftergoal', 'late', command, actionsToGoal, 'SESSION_FINISHED', 0, {
        phase: 'finished',
      }),
    );
    suite.push({
      name: 'Cooperative goal accumulates participants and stops immediately at target',
      kind: 'limit',
      steps: goalSteps,
    });
  }
  if (!manifest.trigger.audience.includes('viewer')) {
    const denied = step('denied', 'ben', team?.joinCommand ?? command, 0, 'AUDIENCE', 0);
    denied.roles = ['viewer'];
    suite.push({
      name: 'Session joins and contributions enforce the declared audience',
      kind: 'role',
      steps: [denied, ...join(), first()],
    });
  }
  if (d.maxParticipants > 1 && (!Number.isFinite(target) || d.contribution.points < target)) {
    const otherTeam = d.teams[1] ?? team,
      otherKey = otherTeam?.id ?? 'community';
    suite.push({
      name: 'Fresh session isolates participants and preserves both contributions',
      kind: 'happy',
      steps: [
        ...join(),
        first(),
        ...(otherTeam ? [step('joinben', 'ben', otherTeam.joinCommand, 2, 'ACCEPTED', 0)] : []),
        step('ben', 'ben', command, 3, 'ACCEPTED', -2, {
          scores: {
            [otherKey]: otherKey === scoreKey ? d.contribution.points * 2 : d.contribution.points,
          },
          participants: { ada: { contributions: 1 }, ben: { contributions: 1 } },
        }),
      ],
    });
  }
  return suite;
}

function compactFailure(report: Omit<VerificationReport, 'failureReport'>) {
  const lines: string[] = [];
  for (const stage of report.stages)
    if (stage.status === 'failed') lines.push(`Stage ${stage.id} failed: ${stage.summary}`);
  for (const finding of report.findings.filter((f) => f.severity === 'error'))
    lines.push(
      `- ${finding.rule}${finding.line ? ` (line ${finding.line})` : ''}: ${finding.message}`,
    );
  for (const result of [...report.generated, ...report.host].filter((r) => !r.passed)) {
    lines.push(`Scenario "${result.name}" (${result.origin}) failed:`);
    for (const step of result.steps.filter((s) => !s.passed))
      lines.push(
        `  step ${step.id} ${step.viewer} ${step.twitch ? `${step.twitch.kind}(${step.twitch.amount})` : `"${step.text}"`} @${step.at}ms expected ${step.expect}` +
          `${step.expectEffects === null ? '' : `/${step.expectEffects} effects`}, got ${step.actual}/${step.actualEffects}${step.expectSession ? `; state expected ${JSON.stringify(step.expectSession)}, got ${JSON.stringify(step.session)}` : ''}${step.expectTimers ? `; timers expected ${JSON.stringify(step.expectTimers)}, got ${JSON.stringify(step.timers ?? { fired: 0, effects: 0 })}` : ''}`,
      );
  }
  const text = lines.join('\n');
  return text.length > 4096 ? `${text.slice(0, 4080)}\n…truncated` : text;
}

/**
 * The fixed validation chain: manifest → static analysis → compile/instrument →
 * generated scenarios → host suite. Later stages are skipped after a failure.
 */
export async function verifyCandidate(candidate: {
  source: string;
  manifest: unknown;
  tests: unknown;
}): Promise<VerificationReport> {
  const stages: StageReport[] = [];
  let findings: Finding[] = [];
  let capabilitiesUsed: Capability[] = [];
  let generated: ScenarioResult[] = [];
  let host: ScenarioResult[] = [];
  let artifactId: string | null = null;
  const timed = async <T>(fn: () => Promise<T> | T) => {
    const started = performance.now();
    const value = await fn();
    return { value, durationMs: Math.round(performance.now() - started) };
  };
  const skip = (id: StageId, label: string) =>
    stages.push({
      id,
      label,
      status: 'skipped',
      durationMs: 0,
      summary: 'Skipped after an earlier failure.',
    });
  const finish = () => {
    const base = {
      ok: stages.every((stage) => stage.status === 'passed'),
      artifactId,
      stages,
      findings,
      capabilitiesUsed,
      generated,
      host,
    };
    return { ...base, failureReport: base.ok ? null : compactFailure(base) };
  };

  const manifest = await timed(() => manifestSchema.safeParse(candidate.manifest));
  const tests = scenariosSchema.safeParse(candidate.tests);
  if (!manifest.value.success) {
    stages.push({
      id: 'manifest',
      label: 'Permission manifest',
      status: 'failed',
      durationMs: manifest.durationMs,
      summary: manifest.value.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`)
        .join('; '),
    });
    for (const [id, label] of [
      ['static', 'Restricted syntax'],
      ['compile', 'Sandbox compile'],
      ['generated', 'Generated tests'],
      ['host', 'Host policy checks'],
    ] as const)
      skip(id, label);
    return finish();
  }
  const parsedManifest = manifest.value.data;
  stages.push({
    id: 'manifest',
    label: 'Permission manifest',
    status: 'passed',
    durationMs: manifest.durationMs,
    summary: `Capabilities: ${parsedManifest.capabilities.join(', ') || 'none'}; within host ceilings.`,
  });

  const analysis = await timed(() => analyzeSource(candidate.source, parsedManifest));
  findings = analysis.value.findings;
  capabilitiesUsed = analysis.value.capabilitiesUsed;
  const errors = findings.filter((finding) => finding.severity === 'error');
  stages.push({
    id: 'static',
    label: 'Restricted syntax',
    status: errors.length ? 'failed' : 'passed',
    durationMs: analysis.durationMs,
    summary: errors.length
      ? `${errors.length} rule violation${errors.length === 1 ? '' : 's'}.`
      : `No forbidden syntax; ${findings.length} warning${findings.length === 1 ? '' : 's'}.`,
  });
  if (errors.length) {
    for (const [id, label] of [
      ['compile', 'Sandbox compile'],
      ['generated', 'Generated tests'],
      ['host', 'Host policy checks'],
    ] as const)
      skip(id, label);
    return finish();
  }

  const artifact = { source: candidate.source, manifest: parsedManifest };
  const compiled = await timed(() => {
    const parsed = artifactSchema.safeParse(artifact);
    if (!parsed.success) return 'Source exceeds the size limit.';
    artifactId = artifactIdentity(parsed.data);
    return null;
  });
  stages.push({
    id: 'compile',
    label: 'Sandbox compile',
    status: compiled.value ? 'failed' : 'passed',
    durationMs: compiled.durationMs,
    summary: compiled.value ?? 'Instrumented for QuickJS with call observation and fault guards.',
  });
  if (compiled.value) {
    skip('generated', 'Generated tests');
    skip('host', 'Host policy checks');
    return finish();
  }

  if (!tests.success) {
    stages.push({
      id: 'generated',
      label: 'Generated tests',
      status: 'failed',
      durationMs: 0,
      summary: `Tests are malformed: ${tests.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    });
  } else {
    const kinds = new Set(tests.data.map((scenario) => scenario.kind));
    const missing = (['happy', 'negative'] as const).filter((kind) => !kinds.has(kind));
    const hasEdge = kinds.has('limit') || kinds.has('role') || kinds.has('window');
    const run = await timed(() => runScenarios(artifact, tests.data, 'generated'));
    generated = run.value;
    const passed = generated.filter((result) => result.passed).length;
    const coverage = missing.length || !hasEdge;
    stages.push({
      id: 'generated',
      label: 'Generated tests',
      status: passed === generated.length && !coverage ? 'passed' : 'failed',
      durationMs: run.durationMs,
      summary: coverage
        ? `Needs a happy path, a limit or role edge, and an unrelated-event negative (${passed}/${generated.length} passed).`
        : `${passed}/${generated.length} scenarios passed in the sandbox.`,
    });
  }

  const hostRun = await timed(() => runScenarios(artifact, hostScenarios(parsedManifest), 'host'));
  host = hostRun.value;
  const hostPassed = host.filter((result) => result.passed).length;
  stages.push({
    id: 'host',
    label: 'Host policy checks',
    status: hostPassed === host.length ? 'passed' : 'failed',
    durationMs: hostRun.durationMs,
    summary: `${hostPassed}/${host.length} independent checks passed.`,
  });
  return finish();
}

export { matchesCommand };
