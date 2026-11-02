import {
  PREDICTION_LIMITS,
  SDK_VERSION,
  type AudienceRole,
  type ProjectileAsset,
  type Scenario,
} from '@riff/sdk';
import type { CompileOutput, CompileRequest } from './contract.js';
import { describeAudience, describeWindow, extractIntentHints, rewardTitleOf } from './intent.js';

/** Offline templates for Channel Points redemptions and prediction proposals. Not Codex. */
const REDEEM = /\b(?:redeem(?:s|ed|ing)?|redemptions?|channel points?)\b/i;
const PREDICT = /\bpredictions?\b/i;
// Settlement is creator-only: anything asking code or chat to decide outcomes is refused.
const SETTLE =
  /\b(?:resolve|settle|pick(?:s)? (?:the )?winn(?:er|ing)|choose (?:the )?winn(?:er|ing)|declare (?:the )?winner|pay ?out|end the prediction|cancel the prediction|lock the prediction)\b/i;

const quoted = (intent: string) =>
  [...intent.matchAll(/["“‘']([^"”’']{1,60})["”’']/g)].map((m) => (m[1] ?? '').trim());

const handleFor = (title: string) => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `!${slug || 'reward'}`;
};

const empty = {
  question: null,
  choices: [],
  unsupportedReason: null,
  alternative: null,
  source: null,
  migrationSource: null,
  manifest: null,
  tests: [],
  behavior: { when: '', what: '', who: '', howMuch: '' },
  assumptions: [],
} satisfies Partial<CompileOutput>;

function redemption(request: CompileRequest): CompileOutput {
  const title = rewardTitleOf(request.intent);
  if (!title)
    return {
      ...empty,
      kind: 'question',
      title: 'Which reward?',
      summary: 'The request does not name the Channel Points reward.',
      question: 'Which Channel Points reward title should trigger it? (up to 45 characters)',
      choices: ['Hydrate', 'Stretch break', 'Hype'],
    };
  const hints = extractIntentHints(request.intent);
  const assumptions: string[] = [];
  const asset: ProjectileAsset = hints.asset ?? 'star';
  if (!hints.asset)
    assumptions.push(
      /\b(?:water|splash|drop)/i.test(request.intent)
        ? 'There is no water effect yet, so a star splash appears.'
        : 'Shows a star.',
    );
  const maxPerViewer = hints.maxPerViewer ?? 3;
  if (hints.maxPerViewer === null) assumptions.push('Three redemptions per viewer are admitted.');
  const windowMs = hints.windowMs ?? 60_000;
  if (hints.windowMs === null) assumptions.push('Allowance resets over a rolling 60 seconds.');
  assumptions.push(
    'Riff fulfils accepted redemptions and refunds refused ones; link the reward in Channel Points.',
  );
  const command = handleFor(title);
  const redeem = (
    id: string,
    viewer: string,
    at: number,
    expect: Scenario['steps'][number]['expect'],
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
  const tests: Scenario[] = [
    {
      name: `Redeeming "${title}" shows a ${asset}`,
      kind: 'happy',
      steps: [redeem('r1', 'alice', 0, 'ACCEPTED', 1)],
    },
    {
      name: `Redemption ${maxPerViewer + 1} is refused; another viewer still can`,
      kind: 'limit',
      steps: [
        ...Array.from({ length: maxPerViewer }, (_, i) =>
          redeem(`a${i}`, 'alice', i * 10, 'ACCEPTED', 1),
        ),
        redeem('over', 'alice', maxPerViewer * 10, 'VIEWER_LIMIT', 0),
        redeem('bob', 'bob', maxPerViewer * 10 + 1, 'ACCEPTED', 1),
      ],
    },
    {
      name: 'Typing the handle in chat does nothing',
      kind: 'negative',
      steps: [
        {
          id: 'c1',
          viewer: 'alice',
          roles: ['viewer'],
          text: command,
          at: 0,
          expect: 'UNRELATED',
          effects: 0,
        },
        {
          id: 'c2',
          viewer: 'alice',
          roles: ['viewer'],
          text: 'hello chat',
          at: 1,
          expect: 'UNRELATED',
          effects: 0,
        },
      ],
    },
    {
      name: 'A redelivered redemption is ignored',
      kind: 'duplicate',
      steps: [redeem('d1', 'alice', 0, 'ACCEPTED', 1), redeem('d1', 'alice', 5, 'DUPLICATE', 0)],
    },
  ];
  return {
    ...empty,
    kind: 'candidate',
    title: request.base?.title ?? `${title.split(/\s+/).slice(0, 2).join(' ')} Splash`.slice(0, 80),
    summary: `Redeeming "${title}" with Channel Points sends a ${asset} across the overlay.`,
    source: `async (event, riff) => {\n  await riff.overlay.emit({ kind: 'projectile', asset: '${asset}', x: riff.util.random() });\n}`,
    manifest: {
      sdkVersion: SDK_VERSION,
      experience: null,
      capabilities: ['overlay'],
      trigger: {
        kind: 'points.redeem',
        reward: title,
        command,
        audience: ['viewer'],
        maxPerViewer,
        windowMs,
      },
      limits: {
        effectsPerEvent: 1,
        effectsPerMinute: Math.min(120, Math.max(maxPerViewer * 20, 60)),
      },
    },
    tests,
    behavior: {
      when: `Someone redeems "${title}" with Channel Points`,
      what: `A ${asset} flies across your overlay`,
      who: 'Everyone who redeems the linked reward',
      howMuch: `Up to ${maxPerViewer} per viewer in any ${describeWindow(windowMs)}; refused redemptions are refunded`,
    },
    assumptions,
  };
}

function prediction(request: CompileRequest): CompileOutput {
  if (SETTLE.test(request.intent))
    return {
      ...empty,
      kind: 'unsupported',
      title: 'Creator settles predictions',
      summary: 'Generated interactions may only propose a prediction.',
      unsupportedReason:
        'Only you can lock, resolve or cancel a prediction, from the Predictions panel. Automations and chat never pick winners.',
      alternative:
        'Let a command propose the prediction; you open it and choose the winner in the console.',
    };
  const hints = extractIntentHints(request.intent);
  if (!hints.command)
    return {
      ...empty,
      kind: 'question',
      title: 'Which command?',
      summary: 'The request does not name the command that proposes the prediction.',
      question: 'Which chat command should propose the prediction?',
      choices: ['!predict', '!bet', '!guess'],
    };
  const assumptions: string[] = [];
  const texts = quoted(request.intent).filter(
    (text) => Array.from(text).length <= PREDICTION_LIMITS.titleLength,
  );
  const title = texts[0] ?? 'Will we win this one?';
  if (!texts[0]) assumptions.push('The prediction asks "Will we win this one?".');
  const outcomeTexts = texts
    .slice(1)
    .filter((text) => Array.from(text).length <= PREDICTION_LIMITS.outcomeLength)
    .slice(0, PREDICTION_LIMITS.outcomes.max);
  const outcomes = outcomeTexts.length >= 2 ? outcomeTexts : ['Yes', 'No'];
  if (outcomeTexts.length < 2) assumptions.push('Outcomes are Yes and No.');
  const window = PREDICTION_LIMITS.windowSeconds;
  const stated = hints.windowMs === null ? null : Math.round(hints.windowMs / 1000);
  const windowSeconds =
    stated !== null && stated >= window.min && stated <= window.max ? stated : 120;
  if (windowSeconds !== stated) assumptions.push('Viewers have 120 seconds to predict.');
  const audience: AudienceRole[] = hints.audience ?? ['broadcaster', 'moderator'];
  if (!hints.audience) assumptions.push('Only you and your moderators can propose it.');
  const command = `!${hints.command}`;
  const roles: AudienceRole[] = audience.includes('viewer')
    ? ['viewer']
    : [audience[0] ?? 'broadcaster', 'viewer'];
  const step = (
    id: string,
    text: string,
    at: number,
    expect: Scenario['steps'][number]['expect'],
    r = roles,
  ) => ({ id, viewer: 'host', roles: r, text, at, expect, effects: 0 });
  const tests: Scenario[] = [
    {
      name: `${command} proposes the prediction`,
      kind: 'happy',
      steps: [step('p1', command, 0, 'ACCEPTED')],
    },
    {
      name: 'One proposal per five minutes',
      kind: 'limit',
      steps: [step('p1', command, 0, 'ACCEPTED'), step('p2', command, 1000, 'VIEWER_LIMIT')],
    },
    {
      name: 'Ordinary chat does nothing',
      kind: 'negative',
      steps: [step('c1', 'hello chat', 0, 'UNRELATED'), step('c2', `${command}s`, 1, 'UNRELATED')],
    },
  ];
  if (!audience.includes('viewer'))
    tests.push({
      name: `Viewers outside ${describeAudience(audience)} cannot propose`,
      kind: 'role',
      steps: [step('r1', command, 0, 'AUDIENCE', ['viewer'])],
    });
  const literal = JSON.stringify({ title, outcomes, windowSeconds })
    .replace(/"(title|outcomes|windowSeconds)":/g, '$1: ')
    .replace(/,(?=[a-z])/g, ', ');
  return {
    ...empty,
    kind: 'candidate',
    title: request.base?.title ?? 'Prediction Prompt',
    summary: `${command} proposes "${title}" for you to open; you choose the winner.`,
    source: `async (event, riff) => {\n  await riff.predictions.propose(${literal});\n}`,
    manifest: {
      sdkVersion: SDK_VERSION,
      experience: null,
      capabilities: ['predictions'],
      trigger: { command, audience, maxPerViewer: 1, windowMs: 300_000 },
      limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
    },
    tests,
    behavior: {
      when: `Someone types ${command} in chat`,
      what: `Riff proposes "${title}" (${outcomes.join(' / ')}, ${windowSeconds} s) for you to open`,
      who: audience.includes('viewer') ? 'Everyone in chat' : `Only ${describeAudience(audience)}`,
      howMuch: 'One proposal per 5 min; only you open, lock, resolve or cancel it',
    },
    assumptions,
  };
}

/** Returns an output for redemption or prediction intents, or null for anything else. */
export function compilePointsOffline(request: CompileRequest): CompileOutput | null {
  if (PREDICT.test(request.intent)) return prediction(request);
  if (REDEEM.test(request.intent)) return redemption(request);
  return null;
}
