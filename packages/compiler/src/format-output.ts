import {
  FORMAT_LIMITS,
  MURAL_COLORS,
  QUIZ_ANSWER_COMMANDS,
  SDK_VERSION,
  type AudienceRole,
  type ExperienceDefinition,
  type MuralColor,
  type Scenario,
  type ScenarioStep,
} from '@riff/sdk';
import type { CompileOutput, CompileRequest } from './contract.js';
import { describeAudience, extractIntentHints } from './intent.js';
import { formatKindOf } from './format-hints.js';

/*
 * Offline templates for definition version 3 formats: audience mural, staged composition
 * vote and educational group challenge. They read only explicit, bounded facts and use
 * small built-in option sets/question banks; anything they cannot place faithfully becomes
 * `unsupported` instead of a quietly reduced activity. No audio is ever produced.
 */

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
};
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const count = (raw: string | undefined) =>
  raw === undefined ? null : (WORDS[raw.toLowerCase()] ?? Number(raw));

/** Built-in stage option sets for the offline composition template. */
const STAGE_OPTIONS: Record<string, { label: string; options: [string, string][] }> = {
  tempo: {
    label: 'Tempo',
    options: [
      ['slow', 'Slow · 70 BPM'],
      ['medium', 'Medium · 100 BPM'],
      ['fast', 'Fast · 140 BPM'],
    ],
  },
  instrument: {
    label: 'Instrument',
    options: [
      ['piano', 'Piano'],
      ['guitar', 'Guitar'],
      ['synth', 'Synth'],
      ['drums', 'Drums'],
    ],
  },
  mood: {
    label: 'Mood',
    options: [
      ['happy', 'Happy'],
      ['dreamy', 'Dreamy'],
      ['epic', 'Epic'],
      ['chill', 'Chill'],
    ],
  },
  genre: {
    label: 'Genre',
    options: [
      ['lofi', 'Lo-fi'],
      ['rock', 'Rock'],
      ['pop', 'Pop'],
      ['jazz', 'Jazz'],
    ],
  },
  key: {
    label: 'Key',
    options: [
      ['major', 'Major'],
      ['minor', 'Minor'],
    ],
  },
};

/** Sample question bank; every correct answer is within the first three options. */
const SOLAR_SYSTEM = [
  {
    prompt: 'Which planet is the largest in our solar system?',
    options: ['Jupiter', 'Saturn', 'Earth', 'Neptune'],
    answer: 0,
    explanation: 'Jupiter is the largest planet: about 11 times wider than Earth.',
  },
  {
    prompt: 'Which planet is closest to the Sun?',
    options: ['Venus', 'Mercury', 'Mars', 'Earth'],
    answer: 1,
    explanation: 'Mercury orbits closest to the Sun, at about 58 million km on average.',
  },
  {
    prompt: 'Which planet is known as the Red Planet?',
    options: ['Jupiter', 'Venus', 'Mars', 'Mercury'],
    answer: 2,
    explanation: 'Iron oxide (rust) in its soil and dust gives Mars its red colour.',
  },
  {
    prompt: 'What is at the center of our solar system?',
    options: ['The Sun', 'Earth', 'Jupiter', 'The Moon'],
    answer: 0,
    explanation: 'Every planet orbits the Sun, a star at the center of the solar system.',
  },
  {
    prompt: 'Which planet has the most famous ring system?',
    options: ['Mars', 'Saturn', 'Mercury', 'Venus'],
    answer: 1,
    explanation: 'Saturn’s bright rings are made of ice and rock; other giants have faint rings.',
  },
];

function durationOf(intent: string): number | null {
  const m = /\b(\d{1,4})\s*(seconds?|secs?|s|minutes?|mins?)\b/i.exec(intent);
  if (!m) return null;
  return Number(m[1]) * (/^m/i.test(m[2] ?? '') ? 60_000 : 1000);
}
const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

type Plan = { definition: ExperienceDefinition; assumptions: string[]; topic?: string };

function planMural(intent: string): Plan | string {
  const assumptions: string[] = [];
  const size = /\b(\d{1,2})\s*[x×]\s*(\d{1,2})\b/i.exec(intent);
  const width = size ? Number(size[1]) : 8,
    height = size ? Number(size[2]) : 8;
  if (!size) assumptions.push('The mural is an 8×8 grid.');
  const within = (v: number) =>
    v >= FORMAT_LIMITS.muralSize.min && v <= FORMAT_LIMITS.muralSize.max;
  if (!within(width) || !within(height)) return 'A mural grid is 2×2 to 16×16 cells.';
  const command = /(![a-z][a-z0-9_-]{0,23})/i.exec(intent)?.[1]?.toLowerCase() ?? '!paint';
  const named = (Object.keys(MURAL_COLORS) as MuralColor[]).filter((c) =>
    new RegExp(`\\b${c}\\b`, 'i').test(intent),
  );
  const palette: MuralColor[] =
    named.length >= FORMAT_LIMITS.palette.min
      ? named.slice(0, FORMAT_LIMITS.palette.max)
      : ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'white', 'black'];
  if (named.length < 2)
    assumptions.push('Palette: red, orange, yellow, green, blue, purple, white and black.');
  const paints = /\b(\d{1,3})\s+(?:paints|pixels|cells)\s+(?:per|each|for each)\b/i.exec(intent);
  const perParticipant = paints ? Number(paints[1]) : 5;
  if (!paints) assumptions.push('Each viewer can paint 5 cells.');
  if (perParticipant < 1 || perParticipant > 100) return 'Each viewer can paint 1 to 100 cells.';
  const overwrite =
    !/\b(?:no overwrit\w*|can(?:no|')t (?:be )?overwrit\w*|permanent|final)\b/i.test(intent);
  assumptions.push(
    overwrite
      ? 'Later paint replaces a cell’s color.'
      : 'A painted cell is final; later paint on it is refused.',
  );
  const reveal = /\b(?:reveal\w* at the end|hidden until|surprise reveal)\b/i.test(intent)
    ? 'end'
    : 'live';
  const durationMs = durationOf(intent) ?? 180_000;
  if (durationOf(intent) === null) assumptions.push('The mural stays open for 3 minutes.');
  assumptions.push(
    `Viewers type ${command} <cell> <color>, for example ${command} b3 ${palette[0]}; no free text is shown.`,
  );
  return {
    assumptions,
    definition: {
      version: 3,
      title: 'Pixel Mural',
      durationMs,
      maxParticipants: 256,
      teams: [],
      resource: { name: 'paints', perParticipant },
      contribution: { command, points: 1 },
      objective: { kind: 'highest-score', target: null },
      format: { kind: 'mural', width, height, palette, overwrite, reveal },
    },
  };
}

function planComposition(intent: string): Plan | string {
  const assumptions: string[] = [];
  const list = /\bstages?\s*[:\-–—]\s*([a-z ,]+?)(?:[.;!]|$)/i.exec(intent)?.[1];
  const names = (list ?? '')
    .split(/\s*,\s*|\s+and\s+|\s+then\s+/i)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!names.length)
    return 'Name the stages, for example "in three stages: tempo, instrument, mood".';
  const stated = count(/\b(two|three|four|\d)\s+stages?\b/i.exec(intent)?.[1]);
  if (stated !== null && stated !== names.length)
    return 'The stated number of stages does not match the named stages.';
  if (names.length < FORMAT_LIMITS.stages.min || names.length > FORMAT_LIMITS.stages.max)
    return 'A composition vote has 2 to 4 stages.';
  const unknown = names.filter((n) => !STAGE_OPTIONS[n]);
  if (unknown.length)
    return `The offline compiler has built-in options only for tempo, instrument, mood, genre and key (not ${unknown.join(', ')}).`;
  const command = /(![a-z][a-z0-9_-]{0,23})/i.exec(intent)?.[1]?.toLowerCase() ?? '!vote';
  const stageMs = 60_000;
  const durationMs = durationOf(intent) ?? stageMs * names.length;
  if (durationOf(intent) === null) assumptions.push('Each stage is open for 60 seconds.');
  assumptions.push(
    `Viewers type ${command} <option> (name or number) once per stage; ties go to the first listed option.`,
    'The result is shown as a composition card on the overlay; no sound is played.',
  );
  return {
    assumptions,
    definition: {
      version: 3,
      title: 'Song Stages',
      durationMs,
      maxParticipants: 256,
      teams: [],
      resource: { name: 'votes', perParticipant: names.length },
      contribution: { command, points: 1 },
      objective: { kind: 'highest-score', target: null },
      format: {
        kind: 'composition',
        tieBreak: 'first-listed',
        stages: names.map((name) => {
          const set = STAGE_OPTIONS[name];
          return {
            id: name,
            label: set?.label ?? titleCase(name),
            options: (set?.options ?? []).map(([id, label]) => ({ id, label })),
          };
        }),
      },
    },
  };
}

function planQuiz(intent: string): Plan | string {
  const assumptions: string[] = [];
  const n = count(/\b(one|two|three|four|five|\d{1,2})[- ]questions?\b/i.exec(intent)?.[1]) ?? null;
  const questions = n ?? 3;
  if (n === null) assumptions.push('The quiz has 3 questions.');
  if (questions < FORMAT_LIMITS.questions.min || questions > FORMAT_LIMITS.questions.max)
    return 'A quiz has 1 to 5 questions.';
  const topic = /\babout\s+(?:the\s+)?([a-z][a-z ]{1,40}?)(?:\s+with\b|[.,;!]|$)/i
    .exec(intent)?.[1]
    ?.trim()
    .toLowerCase();
  if (topic !== 'solar system' && topic !== 'planets')
    return `The offline compiler only has a sample solar-system question bank${topic ? `, not questions about ${topic}` : ''}. Switch to model compilation to write these questions.`;
  const letters = QUIZ_ANSWER_COMMANDS.filter((c) => new RegExp(`${c}\\b`, 'i').test(intent));
  const options = letters.length >= 2 ? letters.length : 4;
  if (letters.length < 2) assumptions.push('Each question has 4 answers: !a, !b, !c and !d.');
  if (letters.length >= 2 && letters.some((c, i) => QUIZ_ANSWER_COMMANDS[i] !== c))
    return 'Answer commands run in order from !a (for example !a !b !c).';
  const durationMs = durationOf(intent) ?? questions * 30_000;
  if (durationOf(intent) === null) assumptions.push('Each question is open for 30 seconds.');
  assumptions.push(
    'The last 10 seconds of each question reveal the answer and explanation; answers close then.',
    'A question is solved together when at least 60% of answers are right; there is no per-viewer ranking.',
    'Questions come from a built-in solar-system sample; review them before going live.',
  );
  return {
    topic: 'solar system',
    assumptions,
    definition: {
      version: 3,
      title: 'Solar System Quiz',
      durationMs,
      maxParticipants: 256,
      teams: [],
      resource: { name: 'answers', perParticipant: questions },
      contribution: { command: '!a', points: 1 },
      objective: { kind: 'highest-score', target: null },
      format: {
        kind: 'quiz',
        passPercent: 60,
        revealMs: 10_000,
        questions: SOLAR_SYSTEM.slice(0, questions).map((q) => ({
          ...q,
          options: q.options.slice(0, options),
        })),
      },
    },
  };
}

/** Plain-language format summary for the approval card. */
export function describeFormat(d: ExperienceDefinition): string {
  const f = d.format;
  if (!f) return '';
  if (f.kind === 'mural')
    return `paint a ${f.width}×${f.height} mural with ${f.palette.length} colors (${f.reveal === 'end' ? 'revealed at the end' : 'shown live'})`;
  if (f.kind === 'composition')
    return `vote stage by stage (${f.stages.map((s) => s.label).join(' → ')}); the overlay shows the composition`;
  return `${f.questions.length} questions answered with ${QUIZ_ANSWER_COMMANDS.slice(0, Math.max(...f.questions.map((q) => q.options.length))).join(' ')}; solved together at ${f.passPercent}%`;
}

function scenarios(d: ExperienceDefinition, audience: AudienceRole[]): Scenario[] {
  const f = d.format;
  if (!f) return [];
  const roles: AudienceRole[] = audience.includes('viewer')
    ? ['viewer']
    : [audience[0] ?? 'broadcaster', 'viewer'];
  const s = (
    id: string,
    viewer: string,
    text: string,
    at: number,
    expect: ScenarioStep['expect'],
    session?: ScenarioStep['session'],
  ): ScenarioStep => ({
    id,
    viewer,
    roles,
    text,
    at,
    expect,
    effects: expect === 'ACCEPTED' ? 1 : 0,
    ...(session ? { session } : {}),
  });
  const cmd = d.contribution.command;
  const first =
    f.kind === 'mural'
      ? `${cmd} a1 ${f.palette[0]}`
      : f.kind === 'composition'
        ? `${cmd} ${f.stages[0]?.options[0]?.id}`
        : (QUIZ_ANSWER_COMMANDS[f.questions[0]?.answer ?? 0] ?? '!a');
  const list: Scenario[] = [
    {
      name: 'A valid choice is accepted and shows one effect',
      kind: 'happy',
      steps: [
        s('first', 'alice', first, 1, 'ACCEPTED', {
          scores: { community: d.contribution.points },
        }),
      ],
    },
    {
      name: 'Ordinary chat does nothing',
      kind: 'negative',
      steps: [s('unrelated', 'alice', 'hello chat', 0, 'UNRELATED')],
    },
    {
      name: 'Redelivered choices never count twice',
      kind: 'duplicate',
      steps: [
        s('same', 'alice', first, 1, 'ACCEPTED'),
        s('same', 'alice', first, 2, 'DUPLICATE', { scores: { community: d.contribution.points } }),
      ],
    },
    {
      name: 'The exact deadline ends the activity',
      kind: 'limit',
      steps: [s('deadline', 'bob', first, d.durationMs, 'SESSION_FINISHED', { phase: 'finished' })],
    },
  ];
  if (f.kind === 'mural') {
    const cells = f.width * f.height;
    const cell = (i: number) => `${'abcdefghijklmnop'[i % f.width]}${Math.floor(i / f.width) + 1}`;
    const paints = Math.min(d.resource.perParticipant, 20, f.overwrite ? 20 : cells);
    const exhausts =
      d.resource.perParticipant <= 20 && (f.overwrite || d.resource.perParticipant < cells);
    list.push({
      name: 'Only listed cells and colors can be painted',
      kind: 'limit',
      steps: [
        s('bare', 'alice', cmd, 0, 'INVALID_CHOICE'),
        s('free-text', 'alice', `${cmd} a1 hello`, 1, 'INVALID_CHOICE'),
        ...Array.from({ length: paints }, (_, i) =>
          s(`paint${i}`, 'alice', `${cmd} ${cell(i)} ${f.palette[0]}`, i + 2, 'ACCEPTED'),
        ),
        ...(exhausts
          ? [
              s(
                'over',
                'alice',
                `${cmd} ${cell(paints % cells)} ${f.palette[0]}`,
                30,
                'RESOURCE_LIMIT',
                {
                  participants: { alice: { remaining: 0 } },
                },
              ),
            ]
          : []),
      ],
    });
  } else
    list.push({
      name: 'One choice per viewer per stage or question',
      kind: 'limit',
      steps: [
        s('choose', 'alice', first, 1, 'ACCEPTED'),
        s(
          'again',
          'alice',
          f.kind === 'quiz' ? (first === '!a' ? '!b' : '!a') : `${cmd} 2`,
          2,
          'ALREADY_CHOSEN',
        ),
        s(
          'bare',
          'bob',
          f.kind === 'quiz' ? 'hello' : cmd,
          3,
          f.kind === 'quiz' ? 'UNRELATED' : 'INVALID_CHOICE',
        ),
      ],
    });
  return list;
}

/** Offline version 3 templates. Example: compileFormatOffline({ intent, base: null }). */
export function compileFormatOffline(request: CompileRequest): CompileOutput | null {
  if (request.base) return null;
  const kind = formatKindOf(request.intent);
  if (!kind) return null;
  const plan =
    kind === 'mural'
      ? planMural(request.intent)
      : kind === 'composition'
        ? planComposition(request.intent)
        : planQuiz(request.intent);
  if (typeof plan === 'string')
    return {
      ...empty,
      kind: 'unsupported',
      title: 'Unsupported Offline Format',
      summary: 'The offline template compiler cannot faithfully build this activity.',
      unsupportedReason: plan,
      alternative:
        'Use an 8×8 mural with !paint, a song vote in stages such as tempo, instrument and mood, or a solar-system quiz; or switch to model compilation.',
    };
  const d = plan.definition;
  const facts = extractIntentHints(request.intent);
  const audience = facts.audience ?? ['viewer'];
  const assumptions = ['Offline template compiler; no model call.', ...plan.assumptions].slice(
    0,
    8,
  );
  const cmd = d.contribution.command;
  const howTo =
    d.format?.kind === 'mural'
      ? `Type ${cmd} <cell> <color>, e.g. ${cmd} b3 red`
      : d.format?.kind === 'composition'
        ? `Type ${cmd} <option> during each stage`
        : 'Answer each question with !a, !b, !c or !d';
  return {
    ...empty,
    kind: 'candidate',
    title: d.title,
    summary: `${howTo}: ${describeFormat(d)}.`.slice(0, 400),
    source: `async (event, riff) => {\n  const snapshot = riff.session.snapshot();\n  await riff.overlay.emit({ kind: 'projectile', asset: 'star', x: snapshot.revision % 2 === 0 ? 0.25 : 0.75 });\n}`,
    manifest: {
      sdkVersion: SDK_VERSION,
      capabilities: ['overlay', 'session'],
      trigger: {
        command: cmd,
        audience,
        maxPerViewer: d.resource.perParticipant,
        windowMs: d.durationMs,
      },
      limits: { effectsPerEvent: 1, effectsPerMinute: 120 },
      experience: d,
    },
    tests: scenarios(d, audience),
    behavior: {
      when: howTo.slice(0, 200),
      what: describeFormat(d).slice(0, 200),
      who: `${describeAudience(audience)}; up to ${d.maxParticipants} participants`,
      howMuch:
        d.format?.kind === 'mural'
          ? `${d.resource.perParticipant} paints per viewer; open for ${Math.round(d.durationMs / 1000)} seconds`
          : `One choice per viewer per ${d.format?.kind === 'quiz' ? 'question' : 'stage'}; ${Math.round(d.durationMs / 1000)} seconds in total`,
    },
    assumptions,
  };
}
