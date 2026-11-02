import { z } from 'zod';
import {
  FORMAT_LIMITS,
  MURAL_COLORS,
  QUIZ_ANSWER_COMMANDS,
  SESSION_LIMITS,
  type DecisionCode,
  type ExperienceDefinition,
  type ExperienceFormat,
  type MuralColor,
  type SessionFormatState,
  type SessionSnapshot,
} from '@riff/sdk';

/*
 * Definition version 3: declarative non-game formats (audience mural, staged composition
 * vote, educational group challenge). Everything here is host-owned, pure and driven only
 * by the recorded event clock and the session's frozen remaining time, so live play,
 * rehearsal and journal replay reproduce identical state from the same ordered inputs.
 * Viewers only ever pick from bounded sets declared in the definition: no free text is
 * stored, so nothing a viewer types can reach the overlay.
 */

const cleanText = (s: string) =>
  [...s].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
const text = (max: number) => z.string().trim().min(1).max(max).refine(cleanText);
const label = text(SESSION_LIMITS.labelLength);
const id = z
  .string()
  .regex(/^[a-z0-9_-]{1,32}$/)
  .refine((s) => !['__proto__', 'constructor', 'prototype'].includes(s));
const int = (range: { min: number; max: number }) => z.number().int().min(range.min).max(range.max);
const colors = Object.keys(MURAL_COLORS) as [MuralColor, ...MuralColor[]];

/** Strict bounded format block. Example: formatSchema.parse(definition.format). */
export const formatSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('mural'),
      width: int(FORMAT_LIMITS.muralSize),
      height: int(FORMAT_LIMITS.muralSize),
      palette: z
        .array(z.enum(colors))
        .min(FORMAT_LIMITS.palette.min)
        .max(FORMAT_LIMITS.palette.max),
      overwrite: z.boolean(),
      reveal: z.enum(['live', 'end']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('composition'),
      tieBreak: z.literal('first-listed'),
      stages: z
        .array(
          z
            .object({
              id,
              label,
              options: z
                .array(z.object({ id, label: text(FORMAT_LIMITS.optionLength) }).strict())
                .min(FORMAT_LIMITS.options.min)
                .max(FORMAT_LIMITS.options.max),
            })
            .strict(),
        )
        .min(FORMAT_LIMITS.stages.min)
        .max(FORMAT_LIMITS.stages.max),
    })
    .strict(),
  z
    .object({
      kind: z.literal('quiz'),
      passPercent: int(FORMAT_LIMITS.passPercent),
      revealMs: int(FORMAT_LIMITS.revealMs),
      questions: z
        .array(
          z
            .object({
              prompt: text(FORMAT_LIMITS.promptLength),
              options: z
                .array(text(FORMAT_LIMITS.optionLength))
                .min(FORMAT_LIMITS.options.min)
                .max(FORMAT_LIMITS.options.max),
              answer: z
                .number()
                .int()
                .min(0)
                .max(FORMAT_LIMITS.options.max - 1),
              explanation: text(FORMAT_LIMITS.explanationLength),
            })
            .strict(),
        )
        .min(FORMAT_LIMITS.questions.min)
        .max(FORMAT_LIMITS.questions.max),
    })
    .strict(),
]);

/** Number of equal time slots: stages, questions, or one for a mural. */
export function slotCount(f: ExperienceFormat): number {
  return f.kind === 'composition' ? f.stages.length : f.kind === 'quiz' ? f.questions.length : 1;
}
/** Length of one slot window. Example: slotMs(definition). */
export function slotMs(d: ExperienceDefinition): number {
  return d.format ? Math.floor(d.durationMs / slotCount(d.format)) : d.durationMs;
}
/** Current 0-based slot from frozen remaining time (pause-safe). Finished sessions report the last. */
export function currentSlot(
  d: ExperienceDefinition,
  s: Pick<SessionSnapshot, 'remainingMs' | 'phase'>,
): number {
  const f = d.format;
  if (!f) return 0;
  const n = slotCount(f);
  if (s.phase === 'finished') return n - 1;
  return Math.min(n - 1, Math.floor((d.durationMs - s.remainingMs) / slotMs(d)));
}
/** Milliseconds already elapsed inside the current slot. */
export function slotElapsedMs(
  d: ExperienceDefinition,
  s: Pick<SessionSnapshot, 'remainingMs' | 'phase'>,
): number {
  return d.durationMs - s.remainingMs - currentSlot(d, s) * slotMs(d);
}
/** True during a quiz question's reveal window (answers closed, explanation shown). */
export function inReveal(
  d: ExperienceDefinition,
  s: Pick<SessionSnapshot, 'remainingMs' | 'phase'>,
): boolean {
  const f = d.format;
  if (f?.kind !== 'quiz') return false;
  if (s.phase === 'finished') return true;
  return slotElapsedMs(d, s) >= slotMs(d) - f.revealMs;
}

/** Answer and vote commands, in admission order. */
export function formatCommands(d: ExperienceDefinition): string[] {
  const f = d.format;
  if (f?.kind !== 'quiz') return [];
  const options = Math.max(...f.questions.map((q) => q.options.length));
  return QUIZ_ANSWER_COMMANDS.slice(0, options).filter((c) => c !== d.contribution.command);
}

/** Cross-field rules for version 3. Returns creator-readable problems. */
export function formatProblems(d: ExperienceDefinition): string[] {
  const f = d.format;
  if (d.version !== 3) return f === undefined ? [] : ['Only version 3 definitions carry a format'];
  if (!f) return ['Version 3 definitions require a format'];
  const problems: string[] = [];
  if (d.mechanics !== undefined) problems.push('Formats cannot be combined with mechanics');
  if (d.teams.length) problems.push('Formats are shared by the whole community without teams');
  if (d.objective.kind !== 'highest-score' || d.objective.target !== null)
    problems.push('Formats use objective highest-score with a null target');
  const n = slotCount(f);
  const reveal = f.kind === 'quiz' ? f.revealMs : 0;
  if (slotMs(d) - reveal < FORMAT_LIMITS.minActionMs)
    problems.push('Every stage or question needs at least 5 seconds to act');
  if (f.kind === 'mural') {
    if (new Set(f.palette).size !== f.palette.length)
      problems.push('Mural palette colors must be distinct');
  } else {
    if (d.resource.perParticipant !== n)
      problems.push('Each participant gets exactly one choice per stage or question');
  }
  if (f.kind === 'composition') {
    if (new Set(f.stages.map((x) => x.id)).size !== f.stages.length)
      problems.push('Stage ids must be unique');
    for (const stage of f.stages)
      if (new Set(stage.options.map((x) => x.id)).size !== stage.options.length)
        problems.push('Option ids must be unique within a stage');
  }
  if (f.kind === 'quiz') {
    if (d.contribution.command !== QUIZ_ANSWER_COMMANDS[0])
      problems.push('Quiz answers use !a, !b, !c and !d; the contribution command must be !a');
    for (const q of f.questions)
      if (q.answer >= q.options.length)
        problems.push('Each correct answer must be one of its options');
  }
  // Bound the worst case so canonical scores always fit the snapshot schema.
  if (
    d.maxParticipants * d.resource.perParticipant * d.contribution.points >
    SESSION_LIMITS.maxScore
  )
    problems.push('These rules could exceed the score ceiling');
  return problems;
}

const choiceRow = z
  .array(
    z
      .number()
      .int()
      .min(-1)
      .max(FORMAT_LIMITS.options.max - 1),
  )
  .max(Math.max(FORMAT_LIMITS.stages.max, FORMAT_LIMITS.questions.max));
/** JSON shape of persisted format state. Example: formatStateSchema.parse(snapshot.format). */
export const formatStateSchema = z
  .object({
    canvas: z
      .array(
        z
          .number()
          .int()
          .min(-1)
          .max(FORMAT_LIMITS.palette.max - 1),
      )
      .max(FORMAT_LIMITS.muralSize.max ** 2),
    choices: z.unknown().transform((value, ctx): Record<string, number[]> => {
      const result: Record<string, number[]> = Object.create(null);
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length > SESSION_LIMITS.maxParticipants
      ) {
        ctx.addIssue({ code: 'custom', message: 'Invalid bounded dictionary' });
        return z.NEVER;
      }
      for (const [key, item] of Object.entries(value)) {
        const parsed = choiceRow.safeParse(item);
        if (!key || key.length > 100 || !parsed.success) {
          ctx.addIssue({ code: 'custom', message: 'Invalid dictionary entry', path: [key] });
          return z.NEVER;
        }
        result[key] = parsed.data;
      }
      return result;
    }),
  })
  .strict();

/** Fresh format state. Example: createFormatState(definition). */
export function createFormatState(d: ExperienceDefinition): SessionFormatState | undefined {
  const f = d.format;
  if (!f) return undefined;
  return {
    canvas: f.kind === 'mural' ? Array.from({ length: f.width * f.height }, () => -1) : [],
    choices: Object.create(null) as Record<string, number[]>,
  };
}

/** Option counts for one slot, derived from the stored choices. */
export function slotTally(
  d: ExperienceDefinition,
  state: SessionFormatState,
  slot: number,
): number[] {
  const f = d.format;
  const options =
    f?.kind === 'composition'
      ? (f.stages[slot]?.options.length ?? 0)
      : f?.kind === 'quiz'
        ? (f.questions[slot]?.options.length ?? 0)
        : 0;
  const tally = Array.from({ length: options }, () => 0);
  for (const row of Object.values(state.choices)) {
    const choice = row[slot] ?? -1;
    if (choice >= 0 && choice < options) tally[choice] = (tally[choice] ?? 0) + 1;
  }
  return tally;
}
/** Deterministic winner of a tally: most votes, ties (and no votes) to the first listed. */
export function tallyWinner(tally: number[]): number {
  let best = 0;
  for (let i = 1; i < tally.length; i++) if ((tally[i] ?? 0) > (tally[best] ?? 0)) best = i;
  return best;
}
/** Whether a quiz question is solved: correct answers reach passPercent of all answers. */
export function questionSolved(
  d: ExperienceDefinition,
  state: SessionFormatState,
  slot: number,
): boolean {
  const f = d.format;
  if (f?.kind !== 'quiz') return false;
  const q = f.questions[slot];
  if (!q) return false;
  const tally = slotTally(d, state, slot);
  const total = tally.reduce((a, b) => a + b, 0);
  return total > 0 && (tally[q.answer] ?? 0) * 100 >= f.passPercent * total;
}
/** Number of solved quiz questions among the slots that have closed or are being revealed. */
export function solvedCount(d: ExperienceDefinition, s: SessionSnapshot): number {
  const f = d.format;
  if (f?.kind !== 'quiz' || !s.format) return 0;
  let solved = 0;
  for (let i = 0; i < f.questions.length; i++) if (questionSolved(d, s.format, i)) solved++;
  return solved;
}

/** Independent consistency checks for version 3 state. Throws on the first violation. */
export function validateFormatState(d: ExperienceDefinition, s: SessionSnapshot): void {
  const f = d.format;
  if (!f) {
    if (s.format !== undefined) throw new Error('Unexpected format state');
    return;
  }
  if (!s.format) throw new Error('Missing format state');
  const state = formatStateSchema.parse(s.format);
  const contributions = Object.values(s.participants).reduce((a, p) => a + p.contributions, 0);
  if (f.kind === 'mural') {
    const painted = state.canvas.filter((cell) => cell >= 0).length;
    if (
      state.canvas.length !== f.width * f.height ||
      state.canvas.some((cell) => cell >= f.palette.length) ||
      Object.keys(state.choices).length ||
      painted > contributions ||
      (!f.overwrite && painted !== contributions) ||
      (contributions > 0 && painted === 0)
    )
      throw new Error('Invalid mural canvas');
    return;
  }
  const n = slotCount(f);
  const slot = currentSlot(d, s);
  if (state.canvas.length) throw new Error('Unexpected canvas');
  for (const [viewer, row] of Object.entries(state.choices)) {
    const participant = Object.hasOwn(s.participants, viewer) ? s.participants[viewer] : undefined;
    const made = row.filter((choice) => choice >= 0).length;
    if (
      !participant ||
      row.length !== n ||
      participant.contributions !== made ||
      row.some((choice, i) => {
        const options =
          f.kind === 'composition' ? f.stages[i]?.options.length : f.questions[i]?.options.length;
        return choice >= (options ?? 0) || (i > slot && choice >= 0);
      })
    )
      throw new Error('Invalid format choices');
  }
  for (const [viewer, participant] of Object.entries(s.participants))
    if (participant.contributions > 0 && !Object.hasOwn(state.choices, viewer))
      throw new Error('Invalid format choices');
}

export type FormatAction =
  | { kind: 'paint'; cell: number; color: number }
  | { kind: 'choose'; option: number }
  | { kind: 'invalid' };

/**
 * Classify chat text for a version 3 definition. null = not a format command; `invalid`
 * = the command with arguments outside the declared bounded sets (nothing is spent).
 */
export function formatActionFor(
  d: ExperienceDefinition,
  raw: string,
  slot: number,
): FormatAction | null {
  const f = d.format;
  if (!f) return null;
  const tokens = raw.trim().toLowerCase().split(/\s+/);
  const head = tokens[0] ?? '';
  if (f.kind === 'quiz') {
    const index = (QUIZ_ANSWER_COMMANDS as readonly string[]).indexOf(head);
    if (index < 0 || tokens.length !== 1) return null;
    const options = f.questions[slot]?.options.length ?? 0;
    return index < options ? { kind: 'choose', option: index } : { kind: 'invalid' };
  }
  if (head !== d.contribution.command.toLowerCase()) return null;
  if (f.kind === 'mural') {
    const cell = /^([a-p])([1-9]|1[0-6])$/.exec(tokens[1] ?? '');
    const color = f.palette.indexOf((tokens[2] ?? '') as MuralColor);
    if (tokens.length !== 3 || !cell || color < 0) return { kind: 'invalid' };
    const column = (cell[1] ?? 'a').charCodeAt(0) - 97,
      row = Number(cell[2]) - 1;
    if (column >= f.width || row >= f.height) return { kind: 'invalid' };
    return { kind: 'paint', cell: row * f.width + column, color };
  }
  const stage = f.stages[slot];
  const arg = tokens[1] ?? '';
  if (tokens.length !== 2 || !stage) return { kind: 'invalid' };
  const byId = stage.options.findIndex((option) => option.id === arg);
  const byNumber = /^[1-9]$/.test(arg) ? Number(arg) - 1 : -1;
  const option = byId >= 0 ? byId : byNumber < stage.options.length ? byNumber : -1;
  return option >= 0 ? { kind: 'choose', option } : { kind: 'invalid' };
}

/**
 * Canonical command text for sanitized exports (recipes, rehearsal import): the exact
 * lowercase command plus only arguments drawn from the definition's bounded sets, or
 * null when the text is not a valid format command for any slot.
 */
export function canonicalFormatText(d: ExperienceDefinition, raw: string): string | null {
  const f = d.format;
  if (!f) return null;
  for (let slot = 0; slot < slotCount(f); slot++) {
    const action = formatActionFor(d, raw, slot);
    if (action && action.kind !== 'invalid') return raw.trim().toLowerCase().split(/\s+/).join(' ');
  }
  return null;
}

export interface FormatStage {
  code: DecisionCode;
  invoke: boolean;
  reason?: string;
}

/**
 * Stage one format command against an already clock-advanced running snapshot. Mutates `s`
 * only when accepted. Admission order after the shared dedupe/command/audience/phase
 * checks: bounded choice → reveal window → enrollment → one choice per slot → resources
 * → cell ownership.
 */
export function stageFormatAction(
  d: ExperienceDefinition,
  s: SessionSnapshot,
  event: { viewerId: string },
  action: FormatAction,
): FormatStage {
  const f = d.format,
    state = s.format;
  if (!f || !state) throw new Error('Formats require version 3 state');
  if (action.kind === 'invalid') return { code: 'INVALID_CHOICE', invoke: false };
  if (inReveal(d, s)) return { code: 'ANSWER_CLOSED', invoke: false };
  const existing = Object.hasOwn(s.participants, event.viewerId)
    ? s.participants[event.viewerId]
    : undefined;
  if (!existing && Object.keys(s.participants).length >= d.maxParticipants)
    return { code: 'PARTICIPANT_LIMIT', invoke: false };
  const slot = currentSlot(d, s);
  const row =
    action.kind === 'choose' && Object.hasOwn(state.choices, event.viewerId)
      ? state.choices[event.viewerId]
      : undefined;
  if ((row?.[slot] ?? -1) >= 0) return { code: 'ALREADY_CHOSEN', invoke: false };
  if (existing && existing.remaining <= 0) return { code: 'RESOURCE_LIMIT', invoke: false };
  let reason: string;
  if (action.kind === 'paint') {
    if (f.kind !== 'mural') throw new Error('Paint requires a mural');
    if (!f.overwrite && (state.canvas[action.cell] ?? -1) >= 0)
      return { code: 'CELL_TAKEN', invoke: false };
    state.canvas[action.cell] = action.color;
    reason = `Painted ${String.fromCharCode(65 + (action.cell % f.width))}${Math.floor(action.cell / f.width) + 1} ${f.palette[action.color] ?? ''}.`;
  } else {
    if (f.kind === 'mural') throw new Error('Choices require a composition or quiz');
    const next = row ?? Array.from({ length: slotCount(f) }, () => -1);
    next[slot] = action.option;
    Object.defineProperty(state.choices, event.viewerId, {
      value: next,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    reason =
      f.kind === 'composition'
        ? `Vote counted for ${f.stages[slot]?.options[action.option]?.label ?? ''}.`
        : 'Answer locked in; the explanation shows when the question closes.';
  }
  const participant =
    existing ??
    (() => {
      const created = { teamId: null, remaining: d.resource.perParticipant, contributions: 0 };
      Object.defineProperty(s.participants, event.viewerId, {
        value: created,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return created;
    })();
  participant.remaining--;
  participant.contributions++;
  s.scores.community = (s.scores.community ?? 0) + d.contribution.points;
  s.revision++;
  return { code: 'ACCEPTED', invoke: true, reason };
}

/** Slot and reveal state after `elapsedMs` of uninterrupted running time. */
export function slotAt(
  d: ExperienceDefinition,
  elapsedMs: number,
): { slot: number; reveal: boolean } {
  const f = d.format;
  if (!f) return { slot: 0, reveal: false };
  const w = slotMs(d);
  const slot = Math.min(slotCount(f) - 1, Math.floor(elapsedMs / w));
  return { slot, reveal: f.kind === 'quiz' && elapsedMs - slot * w >= w - f.revealMs };
}

/**
 * A valid synthetic action for `slot`: mural cells advance with `variant` (row-major) and
 * colors cycle the palette; composition votes and quiz answers pick option `variant`.
 */
export function formatSampleText(d: ExperienceDefinition, slot = 0, variant = 0): string {
  const f = d.format;
  if (!f) return d.contribution.command;
  if (f.kind === 'mural') {
    const cell = variant % (f.width * f.height);
    const column = String.fromCharCode(97 + (cell % f.width));
    return `${d.contribution.command} ${column}${Math.floor(cell / f.width) + 1} ${f.palette[variant % f.palette.length] ?? f.palette[0]}`;
  }
  if (f.kind === 'composition') {
    const options = f.stages[slot]?.options ?? [];
    return `${d.contribution.command} ${options[variant % options.length]?.id ?? ''}`;
  }
  const options = f.questions[slot]?.options.length ?? 2;
  return QUIZ_ANSWER_COMMANDS[variant % options] ?? '!a';
}

/** Short command usage for on-stream instructions, e.g. "!paint <cell> <color>". */
export function formatUsage(d: ExperienceDefinition): string | null {
  const f = d.format;
  if (!f) return null;
  if (f.kind === 'mural') return `${d.contribution.command} <cell> <color>`;
  if (f.kind === 'composition') return `${d.contribution.command} <option>`;
  const options = Math.max(...f.questions.map((q) => q.options.length));
  return QUIZ_ANSWER_COMMANDS.slice(0, options).join(' / ');
}
