import { useEffect, useState } from 'react';
import { z } from 'zod';
import { request } from '../../lib/api.js';
import type { Version } from '../../lib/types.js';
import { defaultScene, sceneSchema, sceneStateSchema } from '../../scenes/schema.js';
import { Step, Fingerprint, Check } from '../panel-kit.js';
import { profileSchema, type RecipeProfile, type RecipeState } from './contracts.js';
import { Differences } from './differences.js';
import { RecipePreview } from './preview.js';
import { RuleFacts } from './rules.js';
import type { Mutate, RecipeAction } from './use-recipes.js';

const MAX_BYTES = 131072;
const LANGUAGES = { en: 'English', fr: 'Français', es: 'Español', de: 'Deutsch' } as const;
const ROLES = [
  ['viewer', 'Everyone'],
  ['subscriber', 'Subscribers'],
  ['moderator', 'Moderators'],
  ['broadcaster', 'Broadcaster'],
] as const;

export function RemixTab({
  state,
  busy,
  mutate,
  setError,
  setNotice,
  versions,
  onReview,
}: {
  state: RecipeState;
  busy: RecipeAction | null;
  mutate: Mutate;
  setError: (message: string) => void;
  setNotice: (message: string) => void;
  versions: Version[];
  onReview: (id: string) => void;
}) {
  const [input, setInput] = useState('');
  const [fileName, setFileName] = useState('');
  const [dragging, setDragging] = useState(false);
  const [source, setSource] = useState(state.imports[0]?.digest ?? '');
  const [reviewId, setReviewId] = useState('');
  const [target, setTarget] = useState('');
  const [profile, setProfile] = useState<RecipeProfile>(state.profile);
  const [sceneText, setSceneText] = useState(JSON.stringify(state.profile.scene, null, 2));
  // Follow the saved profile when the server revision moves (save, or another tab).
  useEffect(() => {
    setProfile(state.profile);
    setSceneText(JSON.stringify(state.profile.scene, null, 2));
  }, [state.profile.revision]);

  let profileDirty = false;
  let sceneValid = true;
  try {
    profileDirty =
      JSON.stringify({ ...profile, scene: JSON.parse(sceneText) as unknown }) !==
      JSON.stringify(state.profile);
    sceneValid = sceneSchema.safeParse(JSON.parse(sceneText)).success;
  } catch {
    profileDirty = true;
    sceneValid = false;
  }
  const selected = state.imports.find((i) => i.digest === source);
  const review =
    state.reviews.find((r) => r.id === reviewId) ??
    [...state.reviews].reverse().find((r) => r.sourceDigest === source);
  const installedVersions = versions.filter((v) =>
    state.reviews.some((r) => r.installedVersionId === v.id),
  );
  const commandValid = /^![a-z0-9_-]{1,32}$/.test(profile.command);
  const reviewStale =
    !!review &&
    (review.profileRevision !== state.profile.revision ||
      (review.targetVersionId ?? '') !== target);
  const readFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError('Recipe files must be at most 128 KiB.');
      return;
    }
    setFileName(file.name);
    void file
      .text()
      .then(setInput)
      .catch(() => setError('Could not read that recipe file.'));
  };
  const adapt = (generate: boolean) =>
    void mutate(
      'adapt',
      {
        sourceDigest: source,
        profileRevision: state.profile.revision,
        generate,
        ...(target ? { targetVersionId: target } : {}),
      },
      (raw) => {
        setReviewId(z.object({ review: z.object({ id: z.string() }) }).parse(raw).review.id);
        setNotice(
          generate
            ? 'Adaptation and private rehearsal are ready for your review.'
            : 'The exact source rules were verified and rehearsed privately.',
        );
      },
    );
  const adaptBlocker = !selected
    ? 'Import and choose a recipe first.'
    : !selected.supported
      ? 'This recipe needs something your installation does not support.'
      : profileDirty
        ? 'Save your channel profile first; adaptation always uses the saved profile.'
        : null;

  return (
    <ol className="panel-steps">
      <Step
        title="Bring in a recipe"
        done={state.imports.length > 0}
        current={!state.imports.length}
        aside={<span className="panel-hint">{state.imports.length} of 50 imported</span>}
      >
        <div className="recipe-import">
          <label
            className="recipe-drop"
            data-dragging={dragging || undefined}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              readFile(e.dataTransfer.files[0]);
            }}
          >
            <span className="recipe-drop-icon" aria-hidden="true">
              ⇪
            </span>
            <span>
              <b>{fileName || 'Choose recipe file'}</b>
              <span className="panel-hint"> or drop a .json file here · max 128 KiB</span>
            </span>
            <input
              type="file"
              className="sr-only"
              accept=".json,application/json"
              onChange={(e) => readFile(e.target.files?.[0])}
            />
          </label>
          <label>
            Recipe JSON
            <textarea
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setFileName('');
              }}
              maxLength={MAX_BYTES}
              rows={3}
              spellCheck={false}
              placeholder="…or paste a recipe package downloaded from a Riff directory"
            />
          </label>
        </div>
        <div className="panel-actions">
          <button
            type="button"
            className="button"
            disabled={!!busy || !input.trim()}
            onClick={() => {
              let value: unknown;
              try {
                value = JSON.parse(input) as unknown;
              } catch {
                setError('That is not valid JSON. Paste the whole recipe file.');
                return;
              }
              void mutate('import', { package: value }, (_raw, next) => {
                const digest = (value as { digest?: unknown })?.digest;
                setSource(
                  next.imports.find((i) => i.digest === digest)?.digest ??
                    next.imports[0]?.digest ??
                    '',
                );
                setReviewId('');
                setInput('');
                setFileName('');
                setNotice('Pinned source imported privately. Nothing was activated.');
              });
            }}
          >
            {busy === 'import' ? 'Checking integrity…' : 'Import pinned recipe'}
          </button>
          <span className="panel-hint">
            Integrity, license and artwork are checked. Imports never run or go live.
          </span>
        </div>
        {state.imports.length > 0 && (
          <ul className="recipe-sources" aria-label="Imported recipes">
            {state.imports.map((item) => (
              <li key={item.digest}>
                <button
                  type="button"
                  className="recipe-source-pick"
                  aria-pressed={item.digest === source}
                  onClick={() => {
                    setSource(item.digest);
                    setReviewId('');
                  }}
                >
                  <span className="recipe-source-title">{item.package.title}</span>
                  <span className="panel-hint">
                    {item.package.author} · {item.package.license} · edition {item.package.revision}
                  </span>
                  <span className={`badge ${item.supported ? 'good' : 'bad'}`}>
                    {item.supported ? 'Supported' : 'Blocked'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {selected && (
          <article className="panel-surface recipe-source" aria-labelledby="recipe-source-title">
            <div className="recipe-source-head">
              <h3 id="recipe-source-title">
                {selected.package.title} · edition {selected.package.revision}
              </h3>
              <button
                type="button"
                className="button small ghost"
                disabled={
                  !!busy ||
                  state.reviews.some((r) => r.sourceDigest === source && r.installedVersionId)
                }
                title="Installed recipes keep their pinned source for lineage."
                onClick={() =>
                  void mutate('remove', { kind: 'import', digest: source }, (_raw, next) => {
                    setSource(next.imports[0]?.digest ?? '');
                    setNotice('Import removed. Installed candidates are unaffected.');
                  })
                }
              >
                Remove import
              </button>
            </div>
            <p className="panel-hint">
              By {selected.package.author} · {selected.package.license} · pinned{' '}
              <Fingerprint value={source} label="Source digest" /> · updates are opt-in and never
              change this edition
            </p>
            {selected.package.description && <p>{selected.package.description}</p>}
            {selected.blockers.length > 0 && (
              <ul className="panel-checks">
                {selected.blockers.map((blocker) => (
                  <Check ok={false} key={blocker}>
                    {blocker}
                  </Check>
                ))}
              </ul>
            )}
            <RuleFacts manifest={selected.package.manifest} />
            {selected.package.lineage.length > 0 && (
              <p className="panel-hint">
                Remixed from{' '}
                {selected.package.lineage
                  .map((l) => `${l.author} (edition ${l.revision}, ${l.license})`)
                  .join(' → ')}
                . Credits carry forward.
              </p>
            )}
            <details>
              <summary>Source code and full rules</summary>
              <pre>
                {selected.package.source}
                {'\n\n// manifest\n'}
                {JSON.stringify(selected.package.manifest, null, 2)}
              </pre>
            </details>
          </article>
        )}
      </Step>

      <Step
        title="Fit it to your channel"
        done={!!selected && !profileDirty && state.profile.revision > 0}
        current={!!selected && (profileDirty || state.profile.revision === 0)}
        aside={
          <span className="panel-hint">
            {profileDirty ? (
              <b className="director-unsaved">Unsaved changes</b>
            ) : (
              `Profile revision ${state.profile.revision}`
            )}
          </span>
        }
      >
        <form
          className="recipe-profile"
          onSubmit={(e) => {
            e.preventDefault();
            let scene;
            try {
              scene = sceneSchema.parse(JSON.parse(sceneText));
            } catch {
              setError(
                'The layout is not a valid safe scene. Pick a layout preset or fix the JSON.',
              );
              return;
            }
            const parsed = profileSchema.safeParse({ ...profile, scene });
            if (!parsed.success) {
              setError(
                'Check the command (like !splat), the limits and choose at least one audience.',
              );
              return;
            }
            const { revision, ...value } = parsed.data;
            void mutate('profile', { expectedRevision: revision, profile: value }, () =>
              setNotice('Profile saved. Run a fresh adaptation before installing.'),
            );
          }}
        >
          <fieldset disabled={!!busy}>
            <legend className="sr-only">Reviewed channel preferences</legend>
            <div className="panel-grid">
              <label>
                Channel display name
                <input
                  value={profile.displayName}
                  maxLength={80}
                  onChange={(e) => setProfile({ ...profile, displayName: e.target.value })}
                />
              </label>
              <label>
                Proposed command
                <input
                  value={profile.command}
                  maxLength={33}
                  spellCheck={false}
                  aria-invalid={!commandValid || undefined}
                  aria-describedby="recipe-command-hint"
                  onChange={(e) =>
                    setProfile({ ...profile, command: e.target.value.toLowerCase().trim() })
                  }
                />
                <span
                  id="recipe-command-hint"
                  className={commandValid ? 'panel-hint' : 'panel-problem'}
                >
                  {commandValid
                    ? 'Checked against your live and shared commands.'
                    : 'Start with ! then 1–32 lowercase letters, digits, - or _.'}
                </span>
              </label>
              <label>
                Instruction language
                <select
                  value={profile.language}
                  onChange={(e) =>
                    setProfile({
                      ...profile,
                      language: e.target.value as RecipeProfile['language'],
                    })
                  }
                >
                  {Object.entries(LANGUAGES).map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Throws per viewer
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={100}
                  value={Number.isNaN(profile.maxPerViewer) ? '' : profile.maxPerViewer}
                  onChange={(e) => setProfile({ ...profile, maxPerViewer: e.target.valueAsNumber })}
                />
              </label>
              <label>
                Rolling window (seconds)
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={3600}
                  value={Number.isNaN(profile.windowMs) ? '' : profile.windowMs / 1000}
                  onChange={(e) =>
                    setProfile({ ...profile, windowMs: Math.round(e.target.valueAsNumber * 1000) })
                  }
                />
              </label>
            </div>
            <div className="recipe-choices">
              <fieldset>
                <legend>Eligible audience</legend>
                <div className="recipe-chips">
                  {ROLES.map(([role, label]) => (
                    <label className="recipe-chip" key={role}>
                      <input
                        type="checkbox"
                        checked={profile.audience.includes(role)}
                        onChange={(e) =>
                          setProfile({
                            ...profile,
                            audience: e.target.checked
                              ? [...profile.audience, role]
                              : profile.audience.filter((r) => r !== role),
                          })
                        }
                      />
                      {role === 'viewer' ? 'Everyone (free chat)' : label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>Capabilities this remix may use</legend>
                <div className="recipe-chips">
                  {(['overlay', 'session'] as const).map((cap) => (
                    <label className="recipe-chip" key={cap}>
                      <input
                        type="checkbox"
                        checked={profile.capabilities.includes(cap)}
                        onChange={(e) =>
                          setProfile({
                            ...profile,
                            capabilities: e.target.checked
                              ? [...profile.capabilities, cap]
                              : profile.capabilities.filter((c) => c !== cap),
                          })
                        }
                      />
                      {cap === 'overlay' ? 'Overlay effects' : 'Rounds and scores'}
                    </label>
                  ))}
                </div>
                <span className="panel-hint">
                  Missing requirements block install — nothing is substituted.
                </span>
              </fieldset>
            </div>
            <label className="panel-checkbox">
              <input
                type="checkbox"
                checked={profile.reducedMotion}
                onChange={(e) => setProfile({ ...profile, reducedMotion: e.target.checked })}
              />
              <span>
                Reduced motion for this installation
                <span className="panel-hint"> · effects fade in place instead of flying</span>
              </span>
            </label>
            <label className="panel-checkbox">
              <input
                type="checkbox"
                checked={profile.highContrast === true}
                onChange={(e) => setProfile({ ...profile, highContrast: e.target.checked })}
              />
              High contrast for this installation
            </label>
            <label className="panel-checkbox">
              <input
                type="checkbox"
                checked={profile.effectLabels === true}
                onChange={(e) => setProfile({ ...profile, effectLabels: e.target.checked })}
              />
              Text labels for effects
            </label>
            <button
              type="button"
              className="button small ghost"
              disabled={!selected}
              onClick={() =>
                selected &&
                setProfile({
                  ...profile,
                  ...selected.package.presentation,
                  highContrast: selected.package.presentation.highContrast === true,
                  effectLabels: selected.package.presentation.effectLabels === true,
                })
              }
            >
              Use source presentation preferences
            </button>
            <div className="recipe-layout">
              <span className="director-label">Screen layout</span>
              <div className="panel-actions">
                <button
                  type="button"
                  className="button small ghost"
                  onClick={() => setSceneText(JSON.stringify(defaultScene(), null, 2))}
                >
                  Use default safe layout
                </button>
                <button
                  type="button"
                  className="button small ghost"
                  disabled={!selected}
                  onClick={() => setSceneText(JSON.stringify(selected?.package.scene, null, 2))}
                >
                  Use source layout
                </button>
                <label className="recipe-inline-select">
                  <span className="sr-only">Copy an existing canvas</span>
                  <select
                    value=""
                    onChange={(e) => {
                      const id = e.target.value;
                      if (id)
                        void request('GET', `/api/scenes/${id}`)
                          .then((raw) => {
                            const next = z.object({ state: sceneStateSchema }).parse(raw);
                            setSceneText(JSON.stringify(next.state.scene, null, 2));
                            // This menu is a one-shot action and resets, so confirm what happened.
                            const from = versions.find((v) => v.id === id);
                            setNotice(
                              `Layout copied from ${from ? `${from.title} v${from.number}` : 'that version'}. Save the profile to use it.`,
                            );
                          })
                          .catch(() => setError('Could not load that version’s layout.'));
                    }}
                  >
                    <option value="">Copy a canvas from…</option>
                    {versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.title} v{v.number}
                      </option>
                    ))}
                  </select>
                </label>
                {!sceneValid && <span className="panel-problem">Layout JSON is invalid.</span>}
              </div>
              <details>
                <summary>Advanced: edit layout JSON</summary>
                <label>
                  Profile scene JSON
                  <textarea
                    value={sceneText}
                    onChange={(e) => setSceneText(e.target.value)}
                    rows={8}
                    spellCheck={false}
                  />
                </label>
              </details>
            </div>
            <div className="panel-actions">
              <button className="button" disabled={!profileDirty}>
                {busy === 'profile' ? 'Saving…' : 'Save channel profile'}
              </button>
              {profileDirty && (
                <button
                  type="button"
                  className="button ghost"
                  onClick={() => {
                    setProfile(state.profile);
                    setSceneText(JSON.stringify(state.profile.scene, null, 2));
                  }}
                >
                  Discard changes
                </button>
              )}
              <span className="panel-hint">Only the saved profile is used for adaptation.</span>
            </div>
          </fieldset>
        </form>
      </Step>

      <Step
        title="Adapt and rehearse privately"
        done={!!review && !reviewStale}
        current={!adaptBlocker && (!review || reviewStale)}
        aside={<span className="pill private">Private</span>}
      >
        <div className="panel-actions recipe-adapt">
          <label>
            Install destination
            <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!!busy}>
              <option value="">New interaction</option>
              {installedVersions.map((v) => (
                <option key={v.id} value={v.id}>
                  Review update to {v.title} v{v.number}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button primary"
            disabled={!!busy || !!adaptBlocker}
            onClick={() => adapt(true)}
          >
            {busy === 'adapt' ? 'Adapting and rehearsing…' : 'Make this fit my channel'}
          </button>
          <button
            type="button"
            className="button ghost"
            disabled={!!busy || !!adaptBlocker}
            onClick={() => adapt(false)}
          >
            Rehearse exact source rules
          </button>
        </div>
        <p className="panel-hint">
          {adaptBlocker ??
            (busy === 'adapt'
              ? 'The compiler rewrites the recipe for your profile, then the sandbox verifies and rehearses it. This can take up to 3 minutes.'
              : '“Make this fit” rewrites the rules for your profile with the compiler; “Rehearse exact source” keeps the publisher’s code untouched.')}
        </p>
      </Step>

      <Step
        title="Review the differences and install"
        done={!!review?.installedVersionId}
        current={!!review && !reviewStale && !review.installedVersionId}
      >
        {!review ? (
          <p className="panel-hint">The reviewed candidate appears here after rehearsal.</p>
        ) : (
          <section className="panel-surface recipe-review" aria-label="Recipe adaptation review">
            <p
              className="panel-callout"
              data-tone={review.passed && !reviewStale ? 'good' : 'warn'}
            >
              <b>{review.passed ? 'Verification passed' : 'Not ready to install'}</b> ·{' '}
              {reviewStale
                ? 'Your profile or destination changed since this review. Adapt again.'
                : `For ${
                    review.targetVersionId
                      ? `an update to ${versions.find((v) => v.id === review.targetVersionId)?.title ?? 'an installed interaction'}`
                      : 'a new interaction'
                  } · profile revision ${review.profileRevision} · needs only ${review.requiredTwitchScopes.join(', ')}`}
            </p>
            <h4>What changes for your channel</h4>
            <Differences differences={review.differences} />
            <ul className="panel-checks">
              {review.checks.map((check) => {
                const mismatch = check.startsWith('Profile mismatch');
                const anyMismatch = review.checks.some((c) => c.startsWith('Profile mismatch'));
                return (
                  <Check ok={!mismatch && (review.passed || anyMismatch)} key={check}>
                    {check}
                  </Check>
                );
              })}
            </ul>
            <RecipePreview
              proof={review.proof}
              scene={review.scene}
              reducedMotion={state.profile.reducedMotion}
              highContrast={state.profile.highContrast}
              effectLabels={state.profile.effectLabels}
            />
            <details>
              <summary>Exact proposed code and rules</summary>
              <pre>
                {review.source}
                {'\n\n// manifest\n'}
                {JSON.stringify(review.manifest, null, 2)}
              </pre>
            </details>
            <div className="panel-actions">
              <button
                type="button"
                className="button primary"
                disabled={!!busy || profileDirty || !review.passed || reviewStale}
                onClick={() =>
                  void mutate('install', { reviewId: review.id, digest: review.digest }, (raw) => {
                    const id = z.object({ versionId: z.string() }).parse(raw).versionId;
                    setNotice(
                      'Candidate installed. Review its behavior and apply its canvas layout before play.',
                    );
                    onReview(id);
                  })
                }
              >
                {review.installedVersionId
                  ? 'Open installed candidate'
                  : busy === 'install'
                    ? 'Installing…'
                    : 'Install exact reviewed candidate'}
              </button>
              <span className="panel-hint">
                Installing creates a private candidate. You still approve its behavior and layout
                before anything goes live.
              </span>
            </div>
          </section>
        )}
      </Step>
    </ol>
  );
}
