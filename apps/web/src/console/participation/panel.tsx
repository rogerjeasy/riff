import './panel.css';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { request } from '../../lib/api.js';
import { PanelCard, Segmented } from '../panel-kit.js';
import {
  guidanceSchema,
  languages,
  settingsSchema,
  type Guidance,
  type ParticipationSettings,
} from '../../participation/contracts.js';

const LANGUAGE_OPTIONS = [
  {
    value: 'inherit',
    label: 'Per recipe',
    hint: 'Keep each reviewed recipe’s language; English otherwise',
  },
  ...languages.map(([value, label]) => ({ value, label })),
] as const;
const TOGGLES = [
  {
    key: 'reducedMotion',
    label: 'Reduce motion on stream',
    hint: 'Effects fade in place instead of flying. Always wins over a recipe’s setting.',
  },
  {
    key: 'highContrast',
    label: 'High-contrast instruction panels',
    hint: 'Solid black panels with white text for readability over busy scenes.',
  },
  {
    key: 'effectLabels',
    label: 'Name visual effects with text',
    hint: 'Each effect carries a short text label, so it is not conveyed by imagery alone.',
  },
] as const;

/** Channel-wide presentation defaults and a preview of the public viewer guide. */
export function ParticipationPanel() {
  const [saved, setSaved] = useState<ParticipationSettings | null>(null);
  const [settings, setSettings] = useState<ParticipationSettings | null>(null);
  const [preview, setPreview] = useState<Guidance | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const c = new AbortController();
    controller.current = c;
    void request('GET', '/api/participation', undefined, c.signal)
      .then((raw) => {
        if (c.signal.aborted) return;
        const next = z.object({ settings: settingsSchema }).parse(raw).settings;
        setSaved(next);
        setSettings(next);
      })
      .catch(() => {
        if (!c.signal.aborted) setError('Could not load broadcast preferences.');
      });
    return () => c.abort();
  }, []);
  const language = saved?.language === 'inherit' || !saved ? 'en' : saved.language;
  useEffect(() => {
    const c = new AbortController();
    void request('GET', `/participation?language=${language}`, undefined, c.signal)
      .then((raw) => {
        if (!c.signal.aborted) setPreview(guidanceSchema.parse(raw));
      })
      .catch(() => {
        if (!c.signal.aborted) setPreview(null);
      });
    return () => c.abort();
  }, [language, saved?.revision]);
  const dirty = !!settings && JSON.stringify(settings) !== JSON.stringify(saved);
  async function save() {
    if (!settings || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    const { revision, ...body } = settings;
    try {
      const raw = await request(
        'POST',
        '/api/participation/settings',
        { expectedRevision: revision, settings: body },
        controller.current?.signal,
      );
      if (!controller.current?.signal.aborted) {
        const next = z.object({ settings: settingsSchema }).parse(raw).settings;
        setSaved(next);
        setSettings(next);
        setNotice('Broadcast preferences saved. The stream updates immediately.');
      }
    } catch (e) {
      if (!controller.current?.signal.aborted)
        setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      if (!controller.current?.signal.aborted) setBusy(false);
    }
  }
  const status = saved
    ? {
        text: [
          saved.language === 'inherit' ? 'Recipe language' : saved.language.toUpperCase(),
          saved.reducedMotion && 'reduced motion',
          saved.highContrast && 'high contrast',
        ]
          .filter(Boolean)
          .join(' · '),
        tone: 'muted' as const,
      }
    : { text: 'Loading…', tone: 'muted' as const };
  const viewerUrl =
    typeof location === 'undefined' ? '/participate' : `${location.origin}/participate`;

  return (
    <PanelCard
      title="Participation access"
      subtitle="Readable, accessible instructions on stream and a public viewer guide anyone can open."
      status={status}
      actions={
        <a className="button small ghost" href="/participate" target="_blank" rel="noreferrer">
          Viewer guide ↗
        </a>
      }
    >
      <div className="participation-console">
        <div className="participation-console-main">
          <p className="panel-lead">
            Viewers join with free chat. These settings change presentation only — never who may
            play, scores or limits; restrictions you approved stay visible to everyone.
          </p>
          {settings && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <fieldset disabled={busy} className="participation-settings">
                <legend className="sr-only">Broadcast preferences</legend>
                <div className="participation-field">
                  <span className="director-label" id="participation-language">
                    Broadcast language
                  </span>
                  <Segmented
                    label="Broadcast language"
                    value={settings.language}
                    options={LANGUAGE_OPTIONS}
                    onChange={(value) => setSettings({ ...settings, language: value })}
                  />
                  <span className="panel-hint">
                    {settings.language === 'inherit'
                      ? 'Each recipe keeps its reviewed language; viewers can ask for another with !riff help.'
                      : 'One language for every on-stream panel, including help requests.'}
                  </span>
                </div>
                {TOGGLES.map((toggle) => (
                  <label className="participation-toggle" key={toggle.key}>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={settings[toggle.key]}
                      onChange={(e) => setSettings({ ...settings, [toggle.key]: e.target.checked })}
                    />
                    <span>
                      <b>{toggle.label}</b>
                      <span className="panel-hint">{toggle.hint}</span>
                    </span>
                  </label>
                ))}
                <div className="panel-actions">
                  <button className="button" disabled={!dirty}>
                    {busy ? 'Saving…' : 'Save presentation preferences'}
                  </button>
                  {dirty && (
                    <button
                      type="button"
                      className="button ghost"
                      onClick={() => setSettings(saved)}
                    >
                      Discard changes
                    </button>
                  )}
                </div>
              </fieldset>
            </form>
          )}
          <div className="panel-callout">
            <b>Late arrivals</b> can type <code>!riff help</code> (or <code>!riff help fr</code>,{' '}
            <code>es</code>, <code>de</code>) to bring today’s instructions back on stream. Limited
            to once per viewer every 30 s and six times a minute per channel; Riff never posts in
            chat. Visual priority for first-timers lives in the Adaptive director.
          </div>
        </div>
        <aside className="participation-preview" aria-label="Viewer guide preview">
          <div className="participation-preview-head">
            <h3>What viewers see</h3>
            <button
              type="button"
              className="button small ghost"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(viewerUrl)
                  .then(() => setNotice('Viewer guide link copied.'))
              }
            >
              Copy link
            </button>
          </div>
          {!preview ? (
            <p className="panel-hint">Preview unavailable.</p>
          ) : preview.stopped ? (
            <p className="panel-hint">Participation is stopped — the guide says so.</p>
          ) : !preview.interactions.length ? (
            <p className="panel-hint">Nothing is live, so the guide shows an empty state.</p>
          ) : (
            preview.interactions.map((item) => (
              <article key={item.id} className="participation-preview-card">
                <b>{item.title}</b>
                <span className={`badge ${item.free ? 'good' : 'warn'}`}>
                  {item.free ? 'Free chat' : 'Restricted audience'}
                </span>
                <ul>
                  {item.instructions.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </article>
            ))
          )}
          <p className="panel-hint">
            Public, no sign-in, no viewer names. Shown in{' '}
            {languages.find(([code]) => code === language)?.[1]}; viewers can switch.
          </p>
        </aside>
      </div>
      {notice && (
        <p role="status" className="panel-callout" data-tone="good">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="answer bad">
          {error}
        </p>
      )}
    </PanelCard>
  );
}
