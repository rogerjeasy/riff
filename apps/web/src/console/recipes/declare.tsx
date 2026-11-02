import type { Manifest } from '../../lib/types.js';
import type { LocalizedCopy, RecipeParameter } from './contracts.js';

/** Contrast-checked accents offered to publishers; the server checks them again. */
const DEFAULT_ACCENT = '#ffd166';
export const ACCENT_PALETTE = [DEFAULT_ACCENT, '#7ae582', '#8ecae6', '#ff8fab'];
const USES_CEILING = 20;

export interface Declaration {
  command: boolean;
  uses: boolean;
  usesMin: number;
  usesMax: number;
  window: boolean;
  windowMinS: number;
  windowMaxS: number;
  accent: boolean;
  headline: string;
}
export const emptyDeclaration = (): Declaration => ({
  command: false,
  uses: false,
  usesMin: 1,
  usesMax: 10,
  window: false,
  windowMinS: 10,
  windowMaxS: 300,
  accent: false,
  headline: '',
});

/** Rules parameters can target: a chat command without rounds. */
const plainTrigger = (manifest: Manifest | undefined) =>
  manifest &&
  !manifest.experience &&
  (manifest.trigger.kind === undefined || manifest.trigger.kind === 'chat.command')
    ? manifest.trigger
    : null;

/** Turn the form into declarations whose bounds always include the published values. */
export function declarationsFor(
  form: Declaration,
  manifest: Manifest | undefined,
  language: keyof LocalizedCopy,
): RecipeParameter[] {
  const trigger = plainTrigger(manifest);
  const list: RecipeParameter[] = [];
  if (trigger && form.command) list.push({ id: 'command', kind: 'command', label: 'Chat command' });
  if (trigger && form.uses)
    list.push({
      id: 'maxPerViewer',
      kind: 'number',
      label: 'Uses per viewer',
      min: Math.max(1, Math.min(form.usesMin, trigger.maxPerViewer)),
      max: Math.min(USES_CEILING, Math.max(form.usesMax, trigger.maxPerViewer)),
      step: 1,
    });
  if (trigger && form.window) {
    const min = Math.max(1000, Math.min(form.windowMinS * 1000, trigger.windowMs));
    list.push({
      id: 'windowMs',
      kind: 'number',
      label: 'Rolling window',
      min,
      max: Math.min(3_600_000, Math.max(form.windowMaxS * 1000, trigger.windowMs)),
      step: (trigger.windowMs - min) % 1000 === 0 ? 1000 : 1,
    });
  }
  if (form.accent)
    list.push({
      id: 'accent',
      kind: 'color',
      label: 'Accent color',
      palette: ACCENT_PALETTE,
      default: DEFAULT_ACCENT,
    });
  if (form.headline.trim())
    list.push({
      id: 'headline',
      kind: 'copy',
      label: 'Headline',
      maxLength: 80,
      default: { [language]: form.headline.trim() },
    });
  return list;
}

/** Optional publisher declarations: what remixers may change without a model rewrite. */
export function DeclareParameters({
  form,
  manifest,
  onChange,
}: {
  form: Declaration;
  manifest: Manifest | undefined;
  onChange: (next: Declaration) => void;
}) {
  const trigger = plainTrigger(manifest);
  const set = (patch: Partial<Declaration>) => onChange({ ...form, ...patch });
  const number = (value: number) => (Number.isNaN(value) ? 0 : value);
  return (
    <fieldset className="recipe-param-copy">
      <legend>Let remixers edit (optional)</legend>
      <span className="panel-hint">
        Declared parameters are applied by the recipient’s host without a model rewrite, inside the
        bounds you set, then verified again.
        {!trigger && ' Command and limits apply only to chat-command interactions without rounds.'}
      </span>
      {trigger && (
        <>
          <label className="panel-checkbox">
            <input
              type="checkbox"
              checked={form.command}
              onChange={(e) => set({ command: e.target.checked })}
            />
            Chat command (now {trigger.command})
          </label>
          <label className="panel-checkbox">
            <input
              type="checkbox"
              checked={form.uses}
              onChange={(e) => set({ uses: e.target.checked })}
            />
            Uses per viewer (now {trigger.maxPerViewer}, at most {USES_CEILING})
          </label>
          {form.uses && (
            <div className="panel-grid">
              <label>
                Lowest
                <input
                  type="number"
                  min={1}
                  max={trigger.maxPerViewer}
                  value={form.usesMin}
                  onChange={(e) => set({ usesMin: number(e.target.valueAsNumber) })}
                />
              </label>
              <label>
                Highest
                <input
                  type="number"
                  min={trigger.maxPerViewer}
                  max={USES_CEILING}
                  value={form.usesMax}
                  onChange={(e) => set({ usesMax: number(e.target.valueAsNumber) })}
                />
              </label>
            </div>
          )}
          <label className="panel-checkbox">
            <input
              type="checkbox"
              checked={form.window}
              onChange={(e) => set({ window: e.target.checked })}
            />
            Rolling window (now {trigger.windowMs / 1000} s)
          </label>
          {form.window && (
            <div className="panel-grid">
              <label>
                Shortest (seconds)
                <input
                  type="number"
                  min={1}
                  max={trigger.windowMs / 1000}
                  value={form.windowMinS}
                  onChange={(e) => set({ windowMinS: number(e.target.valueAsNumber) })}
                />
              </label>
              <label>
                Longest (seconds)
                <input
                  type="number"
                  min={trigger.windowMs / 1000}
                  max={3600}
                  value={form.windowMaxS}
                  onChange={(e) => set({ windowMaxS: number(e.target.valueAsNumber) })}
                />
              </label>
            </div>
          )}
        </>
      )}
      <label className="panel-checkbox">
        <input
          type="checkbox"
          checked={form.accent}
          onChange={(e) => set({ accent: e.target.checked })}
        />
        <span>
          Accent color from a contrast-checked palette{' '}
          {ACCENT_PALETTE.map((color) => (
            <span
              key={color}
              className="recipe-swatch"
              style={{ background: color }}
              aria-hidden="true"
            />
          ))}
        </span>
      </label>
      <label>
        Editable headline (leave empty to keep it fixed)
        <input
          value={form.headline}
          maxLength={80}
          placeholder="e.g. Splat the streamer!"
          onChange={(e) => set({ headline: e.target.value })}
        />
      </label>
    </fieldset>
  );
}
