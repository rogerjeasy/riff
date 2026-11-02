import { z } from 'zod';
import {
  SCENARIO_LIMITS,
  SESSION_LIMITS,
  TRIGGER_LIMITS,
  type RecipeLanguage,
  type RecipePackage,
  type RecipeParameter,
  type RecipeParameterChange,
  type RecipeParameterValues,
  type RecipeStyle,
  type Scenario,
} from '@riff/sdk';
import { manifestSchema, scenariosSchema } from '@riff/sandbox';
import { RecipeError, describeError } from './contract.js';
import { findPrivateText } from './secrets.js';

type Manifest = RecipePackage['manifest'];
const LANGUAGES = ['en', 'fr', 'es', 'de'] as const;

/**
 * F29 host ceilings. Declared bounds must sit inside them. The per-viewer ceiling keeps
 * the regenerated limit scenario (n accepted + one blocked + one other viewer) inside
 * `SCENARIO_LIMITS.maxSteps`; the copy caps keep host-rendered lines inside the overlay's
 * 200-character instruction line.
 */
export const PARAMETER_LIMITS = Object.freeze({
  declarations: 6,
  labelLength: 60,
  maxPerViewer: { min: TRIGGER_LIMITS.maxPerViewer.min, max: SCENARIO_LIMITS.maxSteps - 4 },
  windowMs: TRIGGER_LIMITS.windowMs,
  headlineLength: 120,
  experienceTitleLength: SESSION_LIMITS.titleLength,
  palette: 8,
  /** WCAG 1.4.11 non-text contrast: the accent draws the instruction panel's edge. */
  minContrast: 3,
});
/** Opaque overlay panel backgrounds an accent must stay visible against (normal, high contrast). */
export const OVERLAY_PANEL_BACKGROUNDS = Object.freeze(['#13121b', '#000000']);

const hex = z.string().regex(/^#[0-9a-f]{6}$/, 'Use a lowercase #rrggbb color.');
const BIDI_OR_INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
/** Plain display text: trimmed, single spaces, no control, bidi-override or invisible characters. */
const copy = (max: number) =>
  z
    .string()
    .transform((value) => value.trim().replace(/\s+/g, ' '))
    .pipe(
      z
        .string()
        .min(1)
        .max(max)
        .refine(
          (value) =>
            [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
            !BIDI_OR_INVISIBLE.test(value),
          'Remove control or invisible formatting characters.',
        ),
    );
const label = copy(PARAMETER_LIMITS.labelLength);
const localized = (max: number) =>
  z
    .object(Object.fromEntries(LANGUAGES.map((code) => [code, copy(max).optional()])))
    .strict()
    .refine(
      (value) => Object.values(value).some(Boolean),
      'Provide copy in at least one language.',
    );
const int = z.number().int();

export const declarationSchema = z.discriminatedUnion('id', [
  z.object({ id: z.literal('command'), kind: z.literal('command'), label }).strict(),
  z
    .object({
      id: z.enum(['maxPerViewer', 'windowMs']),
      kind: z.literal('number'),
      label,
      min: int,
      max: int,
      step: int.min(1),
    })
    .strict(),
  z
    .object({
      id: z.literal('accent'),
      kind: z.literal('color'),
      label,
      palette: z.array(hex).max(PARAMETER_LIMITS.palette),
      default: hex,
    })
    .strict(),
  z
    .object({
      id: z.literal('headline'),
      kind: z.literal('copy'),
      label,
      maxLength: int.min(1).max(PARAMETER_LIMITS.headlineLength),
      default: localized(PARAMETER_LIMITS.headlineLength),
    })
    .strict(),
  z
    .object({
      id: z.literal('experienceTitle'),
      kind: z.literal('copy'),
      label,
      maxLength: int.min(1).max(PARAMETER_LIMITS.experienceTitleLength),
    })
    .strict(),
]);
export const declarationsSchema = z
  .array(declarationSchema)
  .min(1)
  .max(PARAMETER_LIMITS.declarations)
  .refine(
    (list) => new Set(list.map((item) => item.id)).size === list.length,
    'Declare each parameter once.',
  );
export const valuesSchema = z
  .object({
    command: z.string().optional(),
    maxPerViewer: int.optional(),
    windowMs: int.optional(),
    accent: z.string().optional(),
    headline: z.record(z.string(), z.string()).optional(),
    experienceTitle: z.string().optional(),
  })
  .strict();

/** WCAG relative-luminance contrast ratio of two #rrggbb colors. */
export function contrast(left: string, right: string) {
  const luminance = (color: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => {
      const channel = parseInt(color.slice(at, at + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}
/** The lowest contrast of a color against every overlay panel background. */
export const accentContrast = (color: string) =>
  Math.min(...OVERLAY_PANEL_BACKGROUNDS.map((background) => contrast(color, background)));

const invalid = (message: string) => new RecipeError('INVALID', message);
/** Command and allowance parameters need a plain chat-command projectile manifest. */
const plainCommand = (manifest: Manifest) =>
  !manifest.experience &&
  (manifest.trigger.kind === undefined || manifest.trigger.kind === 'chat.command')
    ? manifest.trigger
    : null;
function checkedManifest(manifest: unknown): Manifest {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success)
    throw invalid(`Parameters need valid rules: ${describeError(parsed.error, 'manifest')}`);
  return parsed.data as Manifest;
}

function assertColor(color: string, field: string) {
  const ratio = accentContrast(color);
  if (ratio < PARAMETER_LIMITS.minContrast)
    throw invalid(
      `${field} ${color} is too dark to see on the overlay panel (contrast ${ratio.toFixed(1)}:1, needs ${PARAMETER_LIMITS.minContrast}:1). Choose a lighter color.`,
    );
}

/**
 * Validate publisher declarations against the edition's own rules: each parameter must
 * apply to this manifest, sit inside host ceilings and contain its default value.
 */
export function checkDeclarations(raw: unknown, manifestInput: unknown): RecipeParameter[] {
  const parsed = declarationsSchema.safeParse(raw);
  if (!parsed.success) throw invalid(describeError(parsed.error, 'parameters'));
  const manifest = checkedManifest(manifestInput);
  const trigger = plainCommand(manifest);
  for (const declaration of parsed.data) {
    const field = `parameters.${declaration.id}`;
    switch (declaration.id) {
      case 'command':
        if (!trigger) throw invalid(`${field} needs a chat-command recipe without rounds.`);
        break;
      case 'maxPerViewer':
      case 'windowMs': {
        if (!trigger) throw invalid(`${field} needs a chat-command recipe without rounds.`);
        const ceiling = PARAMETER_LIMITS[declaration.id];
        const current = trigger[declaration.id];
        if (declaration.min < ceiling.min || declaration.max > ceiling.max)
          throw invalid(`${field} bounds must stay within ${ceiling.min}–${ceiling.max}.`);
        if (declaration.min > declaration.max)
          throw invalid(`${field} minimum must not exceed its maximum.`);
        if (current < declaration.min || current > declaration.max)
          throw invalid(
            `${field} bounds ${declaration.min}–${declaration.max} must include the published value ${current}.`,
          );
        if ((current - declaration.min) % declaration.step !== 0)
          throw invalid(`${field} step must reach the published value ${current}.`);
        break;
      }
      case 'accent':
        for (const color of declaration.palette) assertColor(color, `${field}.palette color`);
        assertColor(declaration.default, `${field}.default`);
        if (declaration.palette.length && !declaration.palette.includes(declaration.default))
          throw invalid(`${field}.default must be one of the palette colors.`);
        break;
      case 'headline':
        for (const [language, value] of Object.entries(declaration.default))
          if (value && value.length > declaration.maxLength)
            throw invalid(
              `${field}.default.${language} is longer than ${declaration.maxLength} characters.`,
            );
        break;
      case 'experienceTitle':
        if (!manifest.experience) throw invalid(`${field} needs a recipe with rounds.`);
        if (manifest.experience.title.length > declaration.maxLength)
          throw invalid(`${field} maxLength must fit the published title.`);
        break;
    }
  }
  const problem = findPrivateText(parsed.data);
  if (problem)
    throw invalid(
      `${problem.field} looks like private or embedded data. Remove it before sharing.`,
    );
  return parsed.data as RecipeParameter[];
}

/** Current values of every declared parameter, read from the edition itself. */
export function parameterDefaults(pack: Pick<RecipePackage, 'manifest' | 'parameters'>) {
  const values: RecipeParameterValues = {};
  const trigger = plainCommand(pack.manifest);
  for (const declaration of pack.parameters ?? []) {
    if (declaration.id === 'command' && trigger) values.command = trigger.command;
    if ((declaration.id === 'maxPerViewer' || declaration.id === 'windowMs') && trigger)
      values[declaration.id] = trigger[declaration.id];
    if (declaration.id === 'accent') values.accent = declaration.default;
    if (declaration.id === 'headline') values.headline = { ...declaration.default };
    if (declaration.id === 'experienceTitle' && pack.manifest.experience)
      values.experienceTitle = pack.manifest.experience.title;
  }
  return values;
}

/** Fresh allowance scenarios for the new limit; data only, run by the same engine. */
function allowanceScenarios(
  previous: Scenario[],
  command: string,
  maxPerViewer: number,
  windowMs: number,
): Scenario[] {
  const sample = previous
    .find((scenario) => scenario.kind === 'limit')
    ?.steps.find((step) => step.expect === 'ACCEPTED');
  const roles = sample?.roles ?? ['viewer'];
  const effects = sample?.effects ?? 1;
  const step = (
    id: string,
    viewer: string,
    at: number,
    expect: 'ACCEPTED' | 'VIEWER_LIMIT',
  ): Scenario['steps'][number] => ({
    id,
    viewer,
    roles,
    text: command,
    at,
    expect,
    effects: expect === 'ACCEPTED' ? effects : 0,
  });
  const list: Scenario[] = [
    {
      name: `Use ${maxPerViewer + 1} is blocked; another viewer still can`,
      kind: 'limit',
      steps: [
        ...Array.from({ length: maxPerViewer }, (_, i) =>
          step(`limit_${i}`, 'synthetic_limit', i * 10, 'ACCEPTED'),
        ),
        step('limit_over', 'synthetic_limit', maxPerViewer * 10, 'VIEWER_LIMIT'),
        step('limit_other', 'synthetic_other', maxPerViewer * 10 + 1, 'ACCEPTED'),
      ],
    },
  ];
  if (maxPerViewer <= 10)
    list.push({
      name: 'The allowance returns after the window',
      kind: 'window',
      steps: [
        ...Array.from({ length: maxPerViewer }, (_, i) =>
          step(`window_${i}`, 'synthetic_window', i, 'ACCEPTED'),
        ),
        step('window_back', 'synthetic_window', Math.max(windowMs, 60_000), 'ACCEPTED'),
      ],
    });
  return list;
}

export interface AppliedParameters {
  manifest: Manifest;
  tests: Scenario[];
  style: RecipeStyle;
  values: RecipeParameterValues;
  changes: RecipeParameterChange[];
}

/**
 * Deterministic host substitution of declared parameters into structured manifest
 * fields, data-only tests and host-rendered style. Source code is never touched, so
 * no recipient text can reach executable code. The result still needs full verification.
 */
export function applyParameters(
  pack: Pick<RecipePackage, 'manifest' | 'parameters' | 'tests'>,
  raw: unknown,
): AppliedParameters {
  const declarations = pack.parameters ?? [];
  if (!declarations.length)
    throw new RecipeError(
      'UNSUPPORTED',
      'This edition declares no editable parameters. Use “Make this fit my channel” instead.',
    );
  const parsedValues = valuesSchema.safeParse(raw);
  if (!parsedValues.success) throw invalid(describeError(parsedValues.error, 'parameters'));
  const input = parsedValues.data;
  const declared = new Map(declarations.map((item) => [item.id, item]));
  for (const key of Object.keys(input))
    if (
      input[key as keyof typeof input] !== undefined &&
      !declared.has(key as RecipeParameter['id'])
    )
      throw invalid(`parameters.${key} is not editable in this edition.`);
  const manifest = structuredClone(checkedManifest(pack.manifest));
  const testsParsed = scenariosSchema.safeParse(pack.tests);
  if (!testsParsed.success)
    throw invalid(`The edition's tests are invalid: ${describeError(testsParsed.error, 'tests')}`);
  let tests = structuredClone(testsParsed.data) as Scenario[];
  const defaults = parameterDefaults(pack);
  const values: RecipeParameterValues = { ...defaults };
  const style: RecipeStyle = {};
  const changes: RecipeParameterChange[] = [];
  const trigger = plainCommand(manifest);

  for (const declaration of declarations) {
    const field = `parameters.${declaration.id}`;
    switch (declaration.id) {
      case 'command': {
        const next = input.command ?? defaults.command;
        if (!trigger || next === undefined) break;
        if (!new RegExp(TRIGGER_LIMITS.commandPattern).test(next))
          throw invalid(`${field} must start with ! then 1–32 lowercase letters, digits, - or _.`);
        const before = trigger.command;
        trigger.command = next;
        values.command = next;
        tests = tests.map((scenario) => ({
          ...scenario,
          steps: scenario.steps.map((step) =>
            step.text.trim().toLowerCase() === before ? { ...step, text: next } : step,
          ),
        }));
        changes.push({
          id: 'command',
          field: 'trigger.command',
          before,
          after: next,
          authority: 'unchanged',
        });
        break;
      }
      case 'maxPerViewer':
      case 'windowMs': {
        const next = input[declaration.id] ?? defaults[declaration.id];
        if (!trigger || next === undefined) break;
        if (next < declaration.min || next > declaration.max)
          throw invalid(`${field} must be between ${declaration.min} and ${declaration.max}.`);
        if ((next - declaration.min) % declaration.step !== 0)
          throw invalid(
            `${field} must move in steps of ${declaration.step} from ${declaration.min}.`,
          );
        const before = trigger[declaration.id];
        trigger[declaration.id] = next;
        values[declaration.id] = next;
        // More uses per viewer, or a shorter window, lets viewers trigger it more often.
        const more = declaration.id === 'maxPerViewer' ? next > before : next < before;
        const fewer = declaration.id === 'maxPerViewer' ? next < before : next > before;
        changes.push({
          id: declaration.id,
          field: `trigger.${declaration.id}`,
          before: String(before),
          after: String(next),
          authority: more ? 'widened' : fewer ? 'narrowed' : 'unchanged',
        });
        break;
      }
      case 'accent': {
        const next = input.accent ?? declaration.default;
        const parsed = hex.safeParse(next);
        if (!parsed.success) throw invalid(`${field} must be a lowercase #rrggbb color.`);
        if (declaration.palette.length && !declaration.palette.includes(next))
          throw invalid(`${field} must be one of the publisher's palette colors.`);
        assertColor(next, field);
        style.accent = next;
        values.accent = next;
        changes.push({
          id: 'accent',
          field: 'style.accent',
          before: declaration.default,
          after: next,
          authority: 'cosmetic',
        });
        break;
      }
      case 'headline': {
        const source = input.headline ?? declaration.default;
        const result: Partial<Record<RecipeLanguage, string>> = {};
        for (const [language, text] of Object.entries(source)) {
          if (!(LANGUAGES as readonly string[]).includes(language))
            throw invalid(`${field}.${language} is not a supported language.`);
          if (!text.trim()) continue;
          const parsed = copy(declaration.maxLength).safeParse(text);
          if (!parsed.success) throw invalid(describeError(parsed.error, `${field}.${language}`));
          result[language as RecipeLanguage] = parsed.data;
        }
        if (!Object.keys(result).length) throw invalid(`${field} needs text in one language.`);
        style.headline = result;
        values.headline = result;
        changes.push({
          id: 'headline',
          field: 'style.headline',
          before: JSON.stringify(declaration.default),
          after: JSON.stringify(result),
          authority: 'cosmetic',
        });
        break;
      }
      case 'experienceTitle': {
        if (!manifest.experience) break;
        const parsed = copy(declaration.maxLength).safeParse(
          input.experienceTitle ?? manifest.experience.title,
        );
        if (!parsed.success) throw invalid(describeError(parsed.error, field));
        const before = manifest.experience.title;
        manifest.experience.title = parsed.data;
        values.experienceTitle = parsed.data;
        changes.push({
          id: 'experienceTitle',
          field: 'experience.title',
          before,
          after: parsed.data,
          authority: 'cosmetic',
        });
        break;
      }
    }
  }
  const problem = findPrivateText({ values, style });
  if (problem)
    throw invalid(`${problem.field} looks like private or embedded data. Remove it first.`);
  if (
    trigger &&
    (values.maxPerViewer !== defaults.maxPerViewer || values.windowMs !== defaults.windowMs)
  )
    tests = [
      ...tests.filter((scenario) => scenario.kind !== 'limit' && scenario.kind !== 'window'),
      ...allowanceScenarios(tests, trigger.command, trigger.maxPerViewer, trigger.windowMs),
    ].slice(0, SCENARIO_LIMITS.maxScenarios);
  return { manifest, tests, style, values, changes };
}
