import { useEffect, useState } from 'react';
import { z } from 'zod';
import { request } from '../../lib/api.js';
import { languages } from '../../participation/contracts.js';

/** Aggregate F20 choices; `null` counts mean 1–2 viewers and are never shown exactly. */
export const viewerLanguagesSchema = z.object({
  enabled: z.boolean(),
  total: z.number().int().nonnegative().nullable(),
  languages: z.array(
    z.object({
      language: z.enum(['en', 'fr', 'es', 'de']),
      count: z.number().int().nonnegative().nullable(),
    }),
  ),
});
export type ViewerLanguages = z.infer<typeof viewerLanguagesSchema>;

const shown = (count: number | null) => (count === null ? 'fewer than 3' : String(count));

/** Creator toggle for `!riff language` plus aggregate counts (no per-viewer list). */
export function ViewerLanguages() {
  const [state, setState] = useState<ViewerLanguages | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    void request('GET', '/api/participation', undefined, c.signal)
      .then((raw) => {
        if (c.signal.aborted) return;
        const parsed = z.object({ viewerLanguages: viewerLanguagesSchema }).safeParse(raw);
        if (parsed.success) setState(parsed.data.viewerLanguages);
      })
      .catch(() => undefined);
    return () => c.abort();
  }, []);
  if (!state) return null;
  async function toggle(enabled: boolean) {
    if (busy) return;
    if (
      !enabled &&
      typeof confirm === 'function' &&
      !confirm('Turn off viewer language choice? Every stored viewer choice is deleted.')
    )
      return;
    setBusy(true);
    setError('');
    try {
      const raw = await request('POST', '/api/participation/viewer-languages', { enabled });
      setState(z.object({ viewerLanguages: viewerLanguagesSchema }).parse(raw).viewerLanguages);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change viewer language choice.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="participation-field" aria-labelledby="viewer-languages-title">
      <label className="participation-toggle">
        <input
          type="checkbox"
          role="switch"
          checked={state.enabled}
          disabled={busy}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>
          <b id="viewer-languages-title">Let viewers choose their language</b>
          <span className="panel-hint">
            Viewers type <code>!riff language fr</code> (en, fr, es, de, or <code>off</code> to
            delete it). Their help and confirmations use it; shared on-stream panels keep the
            broadcast language. Turning this off deletes every stored choice.
          </span>
        </span>
      </label>
      <p className="panel-hint" aria-live="polite">
        {state.total === 0
          ? 'No viewer has chosen a language yet.'
          : `Chosen languages (${shown(state.total)} viewers): ` +
            state.languages
              .filter((l) => l.count !== 0)
              .map(
                (l) =>
                  `${languages.find(([code]) => code === l.language)?.[1] ?? l.language} ${shown(l.count)}`,
              )
              .join(' · ')}
      </p>
      {error && (
        <p role="alert" className="answer bad">
          {error}
        </p>
      )}
    </section>
  );
}
