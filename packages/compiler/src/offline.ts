import { SDK_VERSION, type AudienceRole, type ProjectileAsset, type Scenario } from '@riff/sdk';
import type { CompileOutput, CompileRequest } from './contract.js';
import { describeAudience, describeWindow, extractIntentHints } from './intent.js';
import type { CompilerTransport } from './transport.js';

const UNSUPPORTED =
  /\b(?:say|says|reply|replies|message the chat|chat message|send (?:a )?message|sound|audio|music|poll|prediction|timer|countdown|ban|timeout|shoutout|channel points?|redeem|webhook|http|website)\b/i;

interface Plan {
  title: string;
  command: string;
  audience: AudienceRole[];
  maxPerViewer: number;
  windowMs: number;
  asset: ProjectileAsset;
}
const ASSET_LABEL: Record<ProjectileAsset, [string, string]> = {
  tomato: ['tomato', 'Tomato Toss'],
  star: ['star', 'Star Shower'],
  heart: ['heart', 'Heart Burst'],
};

function scenarios(plan: Plan): Scenario[] {
  const roles: AudienceRole[] = plan.audience.includes('viewer')
    ? ['viewer']
    : [plan.audience[0] ?? 'broadcaster', 'viewer'];
  const s = (
    id: string,
    viewer: string,
    text: string,
    at: number,
    expect: Scenario['steps'][number]['expect'],
    effects: number,
    r = roles,
  ) => ({
    id,
    viewer,
    roles: r,
    text,
    at,
    expect,
    effects,
  });
  const n = plan.maxPerViewer;
  const list: Scenario[] = [
    {
      name: `${plan.command} shows a ${plan.asset}`,
      kind: 'happy',
      steps: [s('m1', 'alice', plan.command, 0, 'ACCEPTED', 1)],
    },
    {
      name: `Throw ${n + 1} is blocked; another viewer still can`,
      kind: 'limit',
      steps: [
        ...Array.from({ length: n }, (_, i) =>
          s(`a${i}`, 'alice', plan.command, i * 10, 'ACCEPTED', 1),
        ),
        s('over', 'alice', plan.command, n * 10, 'VIEWER_LIMIT', 0),
        s('bob', 'bob', plan.command, n * 10 + 1, 'ACCEPTED', 1),
      ],
    },
    {
      name: 'Ordinary chat does nothing',
      kind: 'negative',
      steps: [
        s('c1', 'alice', 'hello chat', 0, 'UNRELATED', 0),
        s('c2', 'alice', `${plan.command}s`, 1, 'UNRELATED', 0),
      ],
    },
    {
      name: 'A redelivered message is ignored',
      kind: 'duplicate',
      steps: [
        s('d1', 'alice', plan.command, 0, 'ACCEPTED', 1),
        s('d1', 'alice', plan.command, 5, 'DUPLICATE', 0),
      ],
    },
  ];
  if (!plan.audience.includes('viewer'))
    list.push({
      name: `Viewers outside ${describeAudience(plan.audience)} are not eligible`,
      kind: 'role',
      steps: [
        s('r1', 'carol', plan.command, 0, 'AUDIENCE', 0, ['viewer']),
        s('r2', 'alice', plan.command, 1, 'ACCEPTED', 1),
      ],
    });
  if (n <= 10)
    list.push({
      name: 'The allowance returns after the window',
      kind: 'window',
      steps: [
        ...Array.from({ length: n }, (_, i) => s(`w${i}`, 'alice', plan.command, i, 'ACCEPTED', 1)),
        s('back', 'alice', plan.command, Math.max(plan.windowMs, 60_000), 'ACCEPTED', 1),
      ],
    });
  return list;
}

/** Deterministic template compiler for offline demos and CI. It is not Codex. */
export function compileOffline(request: CompileRequest): CompileOutput {
  const hints = extractIntentHints(request.intent);
  const base = request.base?.manifest as
    | {
        trigger?: {
          command?: string;
          audience?: AudienceRole[];
          maxPerViewer?: number;
          windowMs?: number;
        };
      }
    | undefined;
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
  if (UNSUPPORTED.test(request.intent))
    return {
      ...empty,
      kind: 'unsupported',
      title: 'Not available yet',
      summary: 'This needs a capability Riff does not grant in SDK 0.3.0.',
      unsupportedReason:
        'Chat replies, sounds, polls, timers and moderation actions are not available yet. Riff can only show overlay projectiles.',
      alternative: 'Show a tomato, star or heart on the overlay when the command is used.',
    };
  const command = hints.command ? `!${hints.command}` : base?.trigger?.command;
  if (!command)
    return {
      ...empty,
      kind: 'question',
      title: 'Which command?',
      summary: 'The request does not name a chat command.',
      question: 'Which chat command should viewers type to trigger it?',
      choices: ['!tomato', '!splat', '!throw'],
    };
  const assumptions: string[] = [];
  const pick = <T>(stated: T | null, previous: T | undefined, fallback: T, note: string): T => {
    if (stated !== null) return stated;
    if (previous !== undefined) return previous;
    assumptions.push(note);
    return fallback;
  };
  const baseAsset = request.base
    ? (['tomato', 'star', 'heart'] as const).find((asset) =>
        request.base?.source.includes(`'${asset}'`),
      )
    : undefined;
  const plan: Plan = {
    command,
    audience: pick(
      hints.audience,
      base?.trigger?.audience,
      ['viewer'],
      'Everyone in chat can take part.',
    ),
    maxPerViewer: pick(
      hints.maxPerViewer,
      base?.trigger?.maxPerViewer,
      3,
      'Three actions per viewer.',
    ),
    windowMs: pick(
      hints.windowMs,
      base?.trigger?.windowMs,
      60_000,
      'Allowance resets over a rolling 60 seconds.',
    ),
    asset: pick(hints.asset, baseAsset, 'tomato', 'Shows a tomato.'),
    title: '',
  };
  plan.title = request.base?.title ?? ASSET_LABEL[plan.asset][1];
  const perMinute = Math.min(120, Math.max(plan.maxPerViewer * 20, 60));
  return {
    ...empty,
    kind: 'candidate',
    title: plan.title,
    summary: `Viewers type ${plan.command} to send a ${plan.asset} across the overlay.`,
    source: `async (event, riff) => {\n  await riff.overlay.emit({ kind: 'projectile', asset: '${plan.asset}', x: riff.util.random() });\n}`,
    manifest: {
      sdkVersion: SDK_VERSION,
      capabilities: ['overlay'],
      trigger: {
        command: plan.command,
        audience: plan.audience,
        maxPerViewer: plan.maxPerViewer,
        windowMs: plan.windowMs,
      },
      limits: { effectsPerEvent: 1, effectsPerMinute: perMinute },
    },
    tests: scenarios(plan),
    behavior: {
      when: `Someone types ${plan.command} in chat`,
      what: `A ${ASSET_LABEL[plan.asset][0]} flies across your overlay`,
      who: plan.audience.includes('viewer')
        ? 'Everyone in chat'
        : `Only ${describeAudience(plan.audience)}`,
      howMuch: `Up to ${plan.maxPerViewer} per viewer in any ${describeWindow(plan.windowMs)}`,
    },
    assumptions,
  };
}

/** Offline transport with the same session/turn contract as Codex. */
export function createOfflineTransport(options: { delayMs?: number } = {}): CompilerTransport {
  return {
    kind: 'offline',
    model: null,
    async open(request) {
      return {
        threadId: null,
        async turn(_prompt, { signal, onProgress }) {
          onProgress({ kind: 'status', text: 'Offline template compiler (no model call).' });
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, options.delayMs ?? 0);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          });
          return { output: compileOffline(request), usage: null };
        },
        async close() {},
      };
    },
  };
}
