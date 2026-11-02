import {
  SDK_VERSION,
  TWITCH_ACTION_CAPABILITIES,
  TWITCH_ACTION_LIMITS,
  type AnnouncementColor,
  type AudienceRole,
  type Scenario,
} from '@riff/sdk';
import type { CompileOutput, CompileRequest } from './contract.js';
import { describeAudience, describeWindow, extractIntentHints } from './intent.js';
import { extractEventHints, SHOUTOUT_WORDS } from './event-hints.js';

/** Which native Twitch action an intent asks for, if any. Predictions stay unsupported. */
export function nativeActionIntent(intent: string): 'poll' | 'announce' | 'shoutout' | null {
  if (/\bpredictions?\b/i.test(intent)) return null;
  if (/\b(?:twitch )?polls?\b/i.test(intent)) return 'poll';
  if (SHOUTOUT_WORDS.test(intent)) return 'shoutout';
  if (/\bannounce(?:ment|s)?\b/i.test(intent)) return 'announce';
  return null;
}

const quoted = (text: string) =>
  [...text.matchAll(/["“]([^"”]{1,120})["”]/g)].map((m) => (m[1] ?? '').trim()).filter(Boolean);
const literal = (value: unknown) => JSON.stringify(value);
const PRIVILEGED: AudienceRole[] = ['broadcaster'];

function empty(): Omit<CompileOutput, 'kind' | 'title' | 'summary'> {
  return {
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
  };
}

function steps(command: string, roles: AudienceRole[], perViewer: number, windowMs: number) {
  const s = (
    id: string,
    viewer: string,
    text: string,
    at: number,
    expect: Scenario['steps'][number]['expect'],
    effects: number,
    r = roles,
  ) => ({ id, viewer, roles: r, text, at, expect, effects });
  const list: Scenario[] = [
    {
      name: `${command} stages the Twitch action`,
      kind: 'happy',
      steps: [s('n1', 'alice', command, 0, 'ACCEPTED', 1)],
    },
    {
      name: `Use ${perViewer + 1} waits for the window`,
      kind: 'limit',
      steps: [
        ...Array.from({ length: perViewer }, (_, i) =>
          s(`l${i}`, 'alice', command, i * 10, 'ACCEPTED', 1),
        ),
        s('lover', 'alice', command, perViewer * 10, 'VIEWER_LIMIT', 0),
        s('lback', 'alice', command, Math.max(windowMs, 60_000), 'ACCEPTED', 1),
      ],
    },
    {
      name: 'Ordinary chat does nothing',
      kind: 'negative',
      steps: [
        s('c1', 'alice', 'hello chat', 0, 'UNRELATED', 0),
        s('c2', 'alice', `${command}s`, 1, 'UNRELATED', 0),
      ],
    },
    {
      name: 'A redelivered message is ignored',
      kind: 'duplicate',
      steps: [
        s('d1', 'alice', command, 0, 'ACCEPTED', 1),
        s('d1', 'alice', command, 5, 'DUPLICATE', 0),
      ],
    },
  ];
  if (!roles.includes('viewer'))
    list.push({
      name: 'Ordinary viewers cannot trigger it',
      kind: 'role',
      steps: [s('r1', 'carol', command, 0, 'AUDIENCE', 0, ['viewer'])],
    });
  return list;
}

/**
 * Deterministic offline compilation of one representative intent per native action.
 * It reads only explicit facts (command, quoted text, durations, roles) and discloses
 * every default as an assumption. It is not Codex.
 */
export function compileTwitchActionOffline(request: CompileRequest): CompileOutput | null {
  const kind = nativeActionIntent(request.intent);
  const baseCapabilities = (request.base?.manifest as { capabilities?: unknown } | undefined)
    ?.capabilities;
  const nativeBase =
    Array.isArray(baseCapabilities) &&
    baseCapabilities.some((c) => (TWITCH_ACTION_CAPABILITIES as readonly unknown[]).includes(c));
  if (request.base && (kind || nativeBase))
    // The template compiler cannot preserve an existing handler while adding or changing
    // a native action; refusing beats silently rewriting the creator's interaction.
    return {
      ...empty(),
      kind: 'unsupported',
      title: 'Describe it as new',
      summary: 'The offline compiler cannot edit native Twitch actions in place.',
      unsupportedReason:
        'Offline mode only edits overlay interactions. Polls, announcements and shoutouts are created from a fresh description.',
      alternative: 'Describe the full interaction as a new one, including its command.',
    };
  if (!kind) return null;
  // F23: a shoutout on a Twitch event is the host-owned raid rule (event compiler) or
  // nothing: only the raiding channel can be shouted out automatically.
  const event = kind === 'shoutout' ? extractEventHints(request.intent) : null;
  if (event?.kind === 'raid') return null;
  if (event)
    return {
      ...empty(),
      kind: 'unsupported',
      title: 'Raids only',
      summary: 'Automatic shoutouts are only for the channel that raids you.',
      unsupportedReason: `Riff can shout out a channel automatically only when it raids you; a ${event.kind} has no channel to shout out.`,
      alternative: `Show a burst of stars on the overlay when it happens, or shout out raiders automatically.`,
    };
  const hints = extractIntentHints(request.intent);
  const text = request.intent.replace(/\s+/g, ' ');
  const assumptions: string[] = [];
  if (!hints.command)
    return {
      ...empty(),
      kind: 'question',
      title: 'Which command?',
      summary: 'The request does not name the chat command that triggers it.',
      question: 'Which chat command should trigger it?',
      choices: kind === 'poll' ? ['!poll', '!vote'] : kind === 'shoutout' ? ['!so'] : ['!hype'],
    };
  const command = `!${hints.command}`;
  const privileged = kind !== 'announce';
  let audience: AudienceRole[];
  if (privileged) {
    if (hints.audience?.some((role) => role === 'viewer' || role === 'subscriber'))
      return {
        ...empty(),
        kind: 'question',
        title: 'Who may trigger it?',
        summary: 'Twitch polls and shoutouts are limited to you and your moderators.',
        question: `Who may use ${command}? Riff only lets you or your moderators start this.`,
        choices: ['Only me (the broadcaster)', 'Me and my moderators'],
      };
    audience = /\b(?:mods|moderators?)\b/i.test(text) ? ['broadcaster', 'moderator'] : PRIVILEGED;
    if (!hints.audience)
      assumptions.push(
        audience.includes('moderator')
          ? `Only you and your moderators can use ${command}.`
          : `Only you (the broadcaster) can use ${command}.`,
      );
  } else {
    audience = hints.audience ?? ['viewer'];
    if (!hints.audience) assumptions.push('Everyone in chat can trigger it.');
  }
  const who = audience.includes('viewer')
    ? 'Everyone in chat'
    : privileged
      ? audience.includes('moderator')
        ? 'Only you and your moderators'
        : 'Only you (the broadcaster)'
      : `Only ${describeAudience(audience)}`;
  const quotes = quoted(text);

  if (kind === 'poll') {
    const limits = TWITCH_ACTION_LIMITS.poll;
    const [title, ...rest] = quotes;
    let choices = rest;
    if (choices.length < 2) {
      const between = text.match(/\b(?:between|choices?|options?)\s*:?\s+([^.!?]+)/i)?.[1] ?? '';
      choices = (between.split(/\s+(?:for|lasting|during)\s+/i)[0] ?? '')
        .split(/\s*(?:,|\bor\b|\band\b)\s*/i)
        .map((c) => c.replace(/["“”']/g, '').trim())
        .filter(Boolean);
    }
    if (!title || choices.length < limits.choices.min)
      return {
        ...empty(),
        kind: 'question',
        title: 'Poll question?',
        summary: 'A Twitch poll needs a question and at least two choices.',
        question: 'What should the poll ask, and which 2–5 choices should it offer?',
        choices: ['"Next game?" with "Speedrun" and "Hardcore"'],
      };
    if (
      [...title].length > limits.titleLength ||
      choices.length > limits.choices.max ||
      choices.some((c) => [...c].length > limits.choiceLength)
    )
      return {
        ...empty(),
        kind: 'unsupported',
        title: 'Poll too long',
        summary: 'Twitch limits poll questions and choices.',
        unsupportedReason: `Twitch polls allow a question up to ${limits.titleLength} characters and ${limits.choices.min}–${limits.choices.max} choices of up to ${limits.choiceLength} characters.`,
        alternative: 'Shorten the question or choices and describe it again.',
      };
    const stated = hints.windowMs !== null ? Math.round(hints.windowMs / 1000) : null;
    const durationSeconds = Math.min(
      limits.durationSeconds.max,
      Math.max(limits.durationSeconds.min, stated ?? 60),
    );
    if (stated === null) assumptions.push('The poll runs for 60 seconds.');
    const windowMs = Math.max(1000, durationSeconds * 1000);
    return {
      ...empty(),
      kind: 'candidate',
      title: 'Channel Poll',
      summary: `${command} starts the Twitch poll “${title}”.`,
      source: `async (event, riff) => {\n  await riff.polls.start({ title: ${literal(title)}, choices: ${literal(choices)}, durationSeconds: ${durationSeconds} });\n}`,
      manifest: {
        sdkVersion: SDK_VERSION,
        experience: null,
        capabilities: ['polls'],
        trigger: { command, audience, maxPerViewer: 1, windowMs },
        limits: { effectsPerEvent: 1, effectsPerMinute: 2 },
      },
      tests: steps(command, audience, 1, windowMs),
      behavior: {
        when: `${audience.includes('moderator') ? 'You or a moderator types' : 'You type'} ${command} in chat`,
        what: `Twitch poll “${title}” (${choices.join(' / ')}) runs for ${describeWindow(durationSeconds * 1000)}`,
        who,
        howMuch: `One poll at a time; once per ${describeWindow(windowMs)} per person`,
      },
      assumptions: [
        ...assumptions,
        'Polls need an Affiliate or Partner channel and the polls grant in Twitch features.',
      ],
    };
  }

  if (kind === 'announce') {
    const message =
      quotes[0] ?? text.match(/\bannounce(?:ment)?\s*:?\s+([^.!?]{1,200})/i)?.[1]?.trim() ?? '';
    if (!message)
      return {
        ...empty(),
        kind: 'question',
        title: 'Announcement text?',
        summary: 'The request does not say what to announce.',
        question: 'What exact text should the announcement post? Put it in quotes.',
        choices: ['"Hype train incoming!"'],
      };
    if ([...message].length > TWITCH_ACTION_LIMITS.announcement.messageLength) return null;
    const color = (['blue', 'green', 'orange', 'purple'] as AnnouncementColor[]).find((c) =>
      new RegExp(`\\b${c}\\b`, 'i').test(text),
    );
    if (!color) assumptions.push('The announcement uses your channel accent color.');
    const maxPerViewer = hints.maxPerViewer ?? 1;
    if (hints.maxPerViewer === null) assumptions.push('Once per person per window.');
    const windowMs = hints.windowMs ?? 60_000;
    if (hints.windowMs === null) assumptions.push('Allowance resets over a rolling 60 seconds.');
    const perMinute = Math.max(maxPerViewer, Math.min(6, maxPerViewer * 2));
    return {
      ...empty(),
      kind: 'candidate',
      title: 'Chat Announcement',
      summary: `${command} posts a highlighted chat announcement.`,
      source: `async (event, riff) => {\n  await riff.chat.announce({ message: ${literal(message)}${color ? `, color: '${color}'` : ''} });\n}`,
      manifest: {
        sdkVersion: SDK_VERSION,
        experience: null,
        capabilities: ['chat.announce'],
        trigger: { command, audience, maxPerViewer, windowMs },
        limits: { effectsPerEvent: 1, effectsPerMinute: perMinute },
      },
      tests: steps(command, audience, maxPerViewer, windowMs),
      behavior: {
        when: `Someone types ${command} in chat`,
        what: `A chat announcement says “${message}”`,
        who,
        howMuch: `Up to ${maxPerViewer} per person in any ${describeWindow(windowMs)}; at most ${TWITCH_ACTION_LIMITS.channel.announcementsPerMinute} announcements a minute channel-wide`,
      },
      assumptions,
    };
  }

  const login = (
    text.match(/\bshout ?-?out(?:\s+to)?\s+@?([a-z0-9_]{1,25})\b/i)?.[1] ??
    text.match(/@([a-z0-9_]{1,25})\b/i)?.[1] ??
    ''
  ).toLowerCase();
  if (!login || ['the', 'a', 'my', 'whoever', 'anyone', 'raider', 'raiders'].includes(login))
    return {
      ...empty(),
      kind: 'question',
      title: 'Which channel?',
      summary: 'Shoutouts go to one channel you approve in Twitch features.',
      question: 'Which channel (Twitch login) should the shoutout go to?',
      choices: ['@twitchdev'],
    };
  const windowMs = TWITCH_ACTION_LIMITS.shoutout.globalCooldownMs;
  return {
    ...empty(),
    kind: 'candidate',
    title: 'Channel Shoutout',
    summary: `${command} shouts out @${login}.`,
    source: `async (event, riff) => {\n  await riff.shoutout.send({ login: ${literal(login)} });\n}`,
    manifest: {
      sdkVersion: SDK_VERSION,
      experience: null,
      capabilities: ['shoutout'],
      trigger: { command, audience, maxPerViewer: 1, windowMs },
      limits: { effectsPerEvent: 1, effectsPerMinute: 2 },
    },
    tests: steps(command, audience, 1, windowMs),
    behavior: {
      when: `${audience.includes('moderator') ? 'You or a moderator types' : 'You type'} ${command} in chat`,
      what: `Twitch shows a shoutout card for @${login}`,
      who,
      howMuch: 'Once every 2 minutes; the same channel at most once an hour (Twitch limits)',
    },
    assumptions: [
      ...assumptions,
      `@${login} must be on your approved shoutout list in Twitch features.`,
    ],
  };
}
