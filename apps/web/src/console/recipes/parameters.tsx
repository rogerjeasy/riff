import { useEffect, useState } from 'react';
import type { LocalizedCopy, RecipePackage, RecipeParameter, RecipeReview } from './contracts.js';
import { requirements } from './contracts.js';

type Language = keyof LocalizedCopy;
const LANGUAGES: Record<Language, string> = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
  de: 'Deutsch',
};
/** Mirrors the server: overlay panel backgrounds an accent must stay visible against. */
const PANEL_BACKGROUNDS = ['#13121b', '#000000'];
const MIN_CONTRAST = 3;
const COMMAND = /^![a-z0-9_-]{1,32}$/;
const FORMATTING = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
/** Control, bidi-override or zero-width characters the server refuses in copy. */
const hidden = (text: string) =>
  [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || FORMATTING.test(text);

export interface ParameterValues {
  command?: string;
  maxPerViewer?: number;
  windowMs?: number;
  accent?: string;
  headline?: LocalizedCopy;
  experienceTitle?: string;
}

function luminance(color: string) {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const c = parseInt(color.slice(at, at + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Lowest WCAG contrast of an accent against every overlay panel background. */
export function accentContrast(color: string) {
  if (!/^#[0-9a-f]{6}$/.test(color)) return 0;
  return Math.min(
    ...PANEL_BACKGROUNDS.map((background) => {
      const [light, dark] = [luminance(color), luminance(background)].sort((a, b) => b - a) as [
        number,
        number,
      ];
      return (light + 0.05) / (dark + 0.05);
    }),
  );
}

/** Published defaults: command and limits from the manifest, color and copy from declarations. */
export function parameterDefaults(pack: RecipePackage): ParameterValues {
  const rules = requirements(pack.manifest);
  const values: ParameterValues = {};
  for (const p of pack.parameters ?? []) {
    if (p.id === 'command' && rules) values.command = rules.trigger.command;
    if (p.id === 'maxPerViewer' && rules) values.maxPerViewer = rules.trigger.maxPerViewer;
    if (p.id === 'windowMs' && rules) values.windowMs = rules.trigger.windowMs;
    if (p.id === 'accent') values.accent = p.default;
    if (p.id === 'headline') values.headline = { ...p.default };
    if (p.id === 'experienceTitle' && rules?.experience)
      values.experienceTitle = rules.experience.title;
  }
  return values;
}

/** Client-side explanation of the first out-of-bounds value; the server checks again. */
function problemFor(p: RecipeParameter, values: ParameterValues): string | null {
  switch (p.id) {
    case 'command':
      return COMMAND.test(values.command ?? '')
        ? null
        : 'Start with ! then 1–32 lowercase letters, digits, - or _.';
    case 'maxPerViewer':
    case 'windowMs': {
      const value = values[p.id];
      if (value === undefined || Number.isNaN(value) || value < p.min || value > p.max)
        return `Choose ${format(p.id, p.min)}–${format(p.id, p.max)}.`;
      return (value - p.min) % p.step ? `Use steps of ${format(p.id, p.step)}.` : null;
    }
    case 'accent': {
      const value = values.accent ?? '';
      if (p.palette.length && !p.palette.includes(value)) return 'Pick one of the palette colors.';
      const ratio = accentContrast(value);
      return ratio < MIN_CONTRAST
        ? `Too dark on the overlay panel (${ratio.toFixed(1)}:1, needs ${MIN_CONTRAST}:1).`
        : null;
    }
    case 'headline': {
      const entries = Object.values(values.headline ?? {}).filter((t): t is string => !!t?.trim());
      if (!entries.length) return 'Write the headline in at least one language.';
      if (entries.some((t) => t.trim().length > p.maxLength))
        return `Keep each headline within ${p.maxLength} characters.`;
      return entries.some(hidden) ? 'Remove control or invisible formatting characters.' : null;
    }
    case 'experienceTitle': {
      const value = values.experienceTitle?.trim() ?? '';
      if (!value) return 'The title cannot be empty.';
      if (value.length > p.maxLength) return `Keep the title within ${p.maxLength} characters.`;
      return hidden(value) ? 'Remove control or invisible formatting characters.' : null;
    }
  }
}
const format = (id: 'maxPerViewer' | 'windowMs', value: number) =>
  id === 'windowMs' ? `${value / 1000} s` : String(value);

/**
 * F29: a form over the edition's declared parameters. Applying it asks the host to
 * substitute the values and run the full verification and rehearsal; no model is used.
 */
export function ParameterForm({
  pack,
  language,
  disabled,
  busy,
  onApply,
}: {
  pack: RecipePackage;
  language: Language;
  disabled: string | null;
  busy: boolean;
  onApply: (values: ParameterValues) => void;
}) {
  const declarations = pack.parameters ?? [];
  const [values, setValues] = useState<ParameterValues>(() => parameterDefaults(pack));
  useEffect(() => setValues(parameterDefaults(pack)), [pack.digest]);
  const problems = Object.fromEntries(
    declarations.map((p) => [p.id, problemFor(p, values)] as const),
  );
  const invalid = Object.values(problems).some(Boolean);
  const rules = requirements(pack.manifest);
  const defaults = parameterDefaults(pack);
  const widened =
    (values.maxPerViewer ?? 0) > (defaults.maxPerViewer ?? Infinity) ||
    (values.windowMs ?? Infinity) < (defaults.windowMs ?? 0);
  const headline =
    values.headline?.[language]?.trim() ||
    Object.values(values.headline ?? {}).find((t) => t?.trim());
  const set = (patch: ParameterValues) => setValues({ ...values, ...patch });

  return (
    <form
      className="recipe-parameters"
      aria-label="Declared parameters"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid && !disabled) onApply(values);
      }}
    >
      <fieldset disabled={busy}>
        <legend>Edit within the publisher’s bounds</legend>
        <div className="panel-grid">
          {declarations.map((p) => {
            const id = `recipe-param-${p.id}`;
            const problem = problems[p.id];
            const hint = (
              <span id={`${id}-hint`} className={problem ? 'panel-problem' : 'panel-hint'}>
                {problem ??
                  (p.kind === 'number'
                    ? `${format(p.id, p.min)}–${format(p.id, p.max)}, steps of ${format(p.id, p.step)}`
                    : p.kind === 'command'
                      ? 'Checked against your live and shared commands.'
                      : p.kind === 'copy'
                        ? `Up to ${p.maxLength} characters, shown as plain text.`
                        : p.palette.length
                          ? 'Publisher palette, contrast-checked.'
                          : 'Any color with at least 3:1 contrast on the overlay panel.')}
              </span>
            );
            if (p.kind === 'command')
              return (
                <label key={p.id} htmlFor={id}>
                  {p.label}
                  <input
                    id={id}
                    value={values.command ?? ''}
                    maxLength={33}
                    spellCheck={false}
                    aria-invalid={!!problem || undefined}
                    aria-describedby={`${id}-hint`}
                    onChange={(e) => set({ command: e.target.value.toLowerCase().trim() })}
                  />
                  {hint}
                </label>
              );
            if (p.kind === 'number') {
              const scale = p.id === 'windowMs' ? 1000 : 1;
              const value = values[p.id];
              return (
                <label key={p.id} htmlFor={id}>
                  {p.label}
                  {p.id === 'windowMs' ? ' (seconds)' : ''}
                  <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={p.min / scale}
                    max={p.max / scale}
                    step={p.step / scale}
                    value={value === undefined || Number.isNaN(value) ? '' : value / scale}
                    aria-invalid={!!problem || undefined}
                    aria-describedby={`${id}-hint`}
                    onChange={(e) => {
                      const next = Math.round(e.target.valueAsNumber * scale);
                      set(p.id === 'windowMs' ? { windowMs: next } : { maxPerViewer: next });
                    }}
                  />
                  {hint}
                </label>
              );
            }
            if (p.kind === 'color')
              return (
                <fieldset key={p.id} className="recipe-param-color" aria-describedby={`${id}-hint`}>
                  <legend>{p.label}</legend>
                  {p.palette.length ? (
                    <div className="recipe-chips">
                      {p.palette.map((color) => (
                        <label className="recipe-chip" key={color}>
                          <input
                            type="radio"
                            name={id}
                            checked={values.accent === color}
                            onChange={() => set({ accent: color })}
                          />
                          <span
                            className="recipe-swatch"
                            style={{ background: color }}
                            aria-hidden="true"
                          />
                          {color}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <input
                      id={id}
                      type="color"
                      value={values.accent ?? '#ffffff'}
                      aria-invalid={!!problem || undefined}
                      onChange={(e) => set({ accent: e.target.value.toLowerCase() })}
                    />
                  )}
                  {hint}
                </fieldset>
              );
            if (p.id === 'headline')
              return (
                <fieldset key={p.id} className="recipe-param-copy" aria-describedby={`${id}-hint`}>
                  <legend>{p.label}</legend>
                  {(Object.keys(LANGUAGES) as Language[]).map((code) => (
                    <label key={code}>
                      {LANGUAGES[code]}
                      <input
                        lang={code}
                        value={values.headline?.[code] ?? ''}
                        maxLength={p.maxLength}
                        onChange={(e) =>
                          set({ headline: { ...values.headline, [code]: e.target.value } })
                        }
                      />
                    </label>
                  ))}
                  {hint}
                </fieldset>
              );
            return (
              <label key={p.id} htmlFor={id}>
                {p.label}
                <input
                  id={id}
                  value={values.experienceTitle ?? ''}
                  maxLength={p.maxLength}
                  aria-invalid={!!problem || undefined}
                  aria-describedby={`${id}-hint`}
                  onChange={(e) => set({ experienceTitle: e.target.value })}
                />
                {hint}
              </label>
            );
          })}
        </div>
        <figure className="recipe-param-preview" aria-label="Live instruction preview">
          <div
            className="recipe-param-panel"
            style={
              values.accent && !problems.accent ? { borderLeftColor: values.accent } : undefined
            }
          >
            {headline && <p lang={language}>{headline}</p>}
            {values.experienceTitle && <p>{values.experienceTitle}</p>}
            {rules && !rules.experience && (
              <p>
                Type <b>{values.command ?? rules.trigger.command}</b> ·{' '}
                {values.maxPerViewer ?? rules.trigger.maxPerViewer} /{' '}
                {(values.windowMs ?? rules.trigger.windowMs) / 1000}s
              </p>
            )}
          </div>
          <figcaption className="panel-hint">
            Preview of the on-stream instruction panel. Copy is shown as plain text.
          </figcaption>
        </figure>
        {widened && (
          <p className="panel-callout" data-tone="warn" role="status">
            <b>Authority widened</b> · viewers can trigger this more often than the published
            edition. The review flags it and the new version needs your approval like any other.
          </p>
        )}
        <div className="panel-actions">
          <button type="submit" className="button primary" disabled={invalid || !!disabled}>
            {busy ? 'Verifying and rehearsing…' : 'Apply parameters and rehearse'}
          </button>
          <button
            type="button"
            className="button ghost"
            onClick={() => setValues(parameterDefaults(pack))}
          >
            Reset to published values
          </button>
          <span className="panel-hint">
            {disabled ??
              (invalid
                ? 'Fix the highlighted values first.'
                : 'No model call: the host substitutes these values, then verifies and rehearses the result.')}
          </span>
        </div>
      </fieldset>
    </form>
  );
}

const AUTHORITY: Record<string, string> = {
  widened: 'Widened',
  narrowed: 'Narrowed',
  unchanged: 'Same reach',
  cosmetic: 'Cosmetic',
};
/** Applied parameters with their authority effect; widened rows are called out. */
export function ParameterChanges({ review }: { review: RecipeReview }) {
  const changes = review.parameters?.changes.filter((c) => c.before !== c.after) ?? [];
  if (!review.parameters) return null;
  return (
    <section aria-label="Applied parameters">
      <h4>Applied parameters</h4>
      {changes.some((c) => c.authority === 'widened') && (
        <p className="panel-callout" data-tone="warn">
          <b>Authority widened</b> · viewers can trigger this more often than the published edition.
          Installing creates a candidate you approve like any other version.
        </p>
      )}
      {changes.length === 0 ? (
        <p className="panel-hint">All parameters keep their published values.</p>
      ) : (
        <ul className="recipe-param-changes">
          {changes.map((c) => (
            <li key={c.id}>
              <code>{c.field}</code> {c.before} → {c.after}{' '}
              <span
                className={`badge ${c.authority === 'widened' ? 'bad' : c.authority === 'narrowed' ? 'good' : ''}`}
              >
                {AUTHORITY[c.authority]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
