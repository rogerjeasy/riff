import { useState } from 'react';
import { z } from 'zod';
import type { Version } from '../../lib/types.js';
import { Step, Fingerprint, Check } from '../panel-kit.js';
import {
  recipePackageSchema,
  downloadRecipe,
  type RecipePackage,
  type RecipeState,
} from './contracts.js';
import { RuleFacts } from './rules.js';
import { DeclareParameters, declarationsFor, emptyDeclaration } from './declare.js';
import type { Mutate, RecipeAction } from './use-recipes.js';

const LICENSES = [
  {
    id: 'MIT',
    name: 'MIT',
    hint: 'Anyone may reuse and remix with credit and the license notice.',
  },
  { id: 'CC-BY-4.0', name: 'CC BY 4.0', hint: 'Anyone may reuse and remix if they credit you.' },
  { id: 'CC0-1.0', name: 'CC0', hint: 'Public domain: no conditions, credit appreciated.' },
] as const;
type License = (typeof LICENSES)[number]['id'];

export function ShareTab({
  state,
  busy,
  mutate,
  setNotice,
  versions,
}: {
  state: RecipeState;
  busy: RecipeAction | null;
  mutate: Mutate;
  setNotice: (message: string) => void;
  versions: Version[];
}) {
  const [versionId, setVersionId] = useState('');
  const [series, setSeries] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [author, setAuthor] = useState('');
  const [license, setLicense] = useState<License>('MIT');
  const [rights, setRights] = useState(false);
  const [exported, setExported] = useState<RecipePackage | null>(null);
  const [declaration, setDeclaration] = useState(emptyDeclaration);
  const approved = versions.filter((v) => v.approvedAt !== null && !v.incident);
  const version = approved.find((v) => v.id === versionId);
  const seriesList = Array.from(
    new Map(state.publications.map((p) => [p.package.recipeId, p])).values(),
  );
  const latest = state.publications
    .filter((p) => p.package.recipeId === series)
    .sort((a, b) => b.package.revision - a.package.revision)[0];
  const nextEdition =
    Math.max(
      latest?.package.revision ?? 0,
      ...(state.exports ?? [])
        .filter((e) => e.recipeId === series && e.revision !== null)
        .map((e) => e.revision ?? 0),
    ) + 1;
  const published =
    !!exported && state.publications.some((p) => p.package.digest === exported.digest);
  const missing = [
    !versionId && 'choose an approved version',
    !title.trim() && 'add a title',
    !description.trim() && 'describe it',
    !author.trim() && 'credit an author',
    !rights && 'confirm your distribution rights',
  ].filter(Boolean);
  const reset = () => setExported(null);
  const parameters = declarationsFor(declaration, version?.manifest, state.profile.language);

  return (
    <ol className="panel-steps">
      <Step title="Describe what you are sharing" done={!!exported} current={!exported}>
        <form
          className="recipe-share"
          onSubmit={(e) => {
            e.preventDefault();
            void mutate(
              'export',
              {
                versionId,
                title,
                description,
                author,
                license,
                rightsAttested: rights,
                // The server assigns the next edition number for this series.
                ...(latest ? { recipeId: latest.package.recipeId } : {}),
                // Omitted when empty so a remix inherits its source's declarations.
                ...(parameters.length ? { parameters } : {}),
              },
              (raw) => {
                setExported(z.object({ package: recipePackageSchema }).parse(raw).package);
                setNotice('Sanitized package ready. Publishing is a separate action.');
              },
            );
          }}
        >
          <fieldset disabled={!!busy}>
            <legend className="sr-only">Public recipe metadata</legend>
            <div className="panel-grid">
              <label>
                Approved version
                <select
                  required
                  value={versionId}
                  onChange={(e) => {
                    setVersionId(e.target.value);
                    const picked = versions.find((v) => v.id === e.target.value);
                    if (picked && !title) setTitle(picked.title);
                    reset();
                  }}
                >
                  <option value="">Choose approved version</option>
                  {approved.map((v) => (
                    <option value={v.id} key={v.id}>
                      {v.title} v{v.number}
                    </option>
                  ))}
                </select>
                {!approved.length && (
                  <span className="panel-hint">
                    Approve an interaction first; only approved versions can be shared.
                  </span>
                )}
              </label>
              <label>
                Publication series
                <select
                  value={series}
                  onChange={(e) => {
                    setSeries(e.target.value);
                    reset();
                  }}
                >
                  <option value="">New recipe</option>
                  {seriesList.map((p) => (
                    <option value={p.package.recipeId} key={p.package.recipeId}>
                      New edition of {p.package.title}
                    </option>
                  ))}
                </select>
                <span className="panel-hint">
                  {latest
                    ? `Becomes edition ${nextEdition}; earlier editions stay pinned.`
                    : 'Starts at edition 1.'}
                </span>
              </label>
              <label>
                Public title
                <input
                  required
                  value={title}
                  maxLength={80}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    reset();
                  }}
                />
              </label>
              <label>
                Public author credit
                <input
                  required
                  value={author}
                  maxLength={80}
                  placeholder="Your channel or creator name"
                  onChange={(e) => {
                    setAuthor(e.target.value);
                    reset();
                  }}
                />
              </label>
            </div>
            <label>
              Public description
              <textarea
                className="recipe-prose"
                required
                value={description}
                maxLength={400}
                rows={3}
                placeholder="What viewers do and why it is fun on stream"
                onChange={(e) => {
                  setDescription(e.target.value);
                  reset();
                }}
              />
              <span className="panel-hint">{description.length}/400</span>
            </label>
            <fieldset className="recipe-licenses">
              <legend>Recipe license</legend>
              <div className="recipe-license-grid">
                {LICENSES.map((item) => (
                  <label
                    className="recipe-license"
                    key={item.id}
                    data-checked={license === item.id || undefined}
                  >
                    <input
                      type="radio"
                      name="recipe-license"
                      value={item.id}
                      checked={license === item.id}
                      onChange={() => {
                        setLicense(item.id);
                        reset();
                      }}
                    />
                    <b>{item.name}</b>
                    <span className="panel-hint">{item.hint}</span>
                  </label>
                ))}
              </div>
              <span className="panel-hint">
                Covers your shared code and copy. Built-in artwork stays under the Riff project
                license.
              </span>
            </fieldset>
            <label className="panel-checkbox">
              <input
                type="checkbox"
                required
                checked={rights}
                onChange={(e) => {
                  setRights(e.target.checked);
                  reset();
                }}
              />
              <span>
                I have rights to distribute this code and copy under the selected license,
                preserving its credits.
              </span>
            </label>
            <DeclareParameters
              form={declaration}
              manifest={version?.manifest}
              onChange={(next) => {
                setDeclaration(next);
                reset();
              }}
            />
            <div className="recipe-shared-scope">
              <ul className="panel-checks" aria-label="Included">
                <Check ok>Code, rules, generated tests and safe layout</Check>
                <Check ok>Title, description, author, license and earlier credits</Check>
              </ul>
              <ul className="panel-checks" aria-label="Never included">
                <li className="panel-check" data-ok="false">
                  <span aria-hidden="true">✕</span>
                  <span>Your prompts, viewers, scores, approvals or credentials</span>
                </li>
                <li className="panel-check" data-ok="false">
                  <span aria-hidden="true">✕</span>
                  <span>Anything that looks like a secret — export is refused instead</span>
                </li>
              </ul>
            </div>
            <div className="panel-actions">
              <button className="button" disabled={missing.length > 0 || !!exported}>
                {busy === 'export' ? 'Preparing…' : 'Prepare sanitized export'}
              </button>
              <span className="panel-hint">
                {missing.length
                  ? `To continue, ${missing.join(', ')}.`
                  : exported
                    ? 'Prepared below. Edit any field to prepare it again.'
                    : 'Preparing never publishes anything.'}
              </span>
            </div>
          </fieldset>
        </form>
      </Step>

      <Step
        title="Download or publish this exact edition"
        done={published}
        current={!!exported && !published}
      >
        {!exported ? (
          <p className="panel-hint">Your sanitized package appears here for inspection first.</p>
        ) : (
          <article className="panel-surface recipe-export" aria-label="Prepared export">
            <div className="recipe-source-head">
              <h3>
                {exported.title} · edition {exported.revision}
              </h3>
              <span className="badge">{exported.license}</span>
            </div>
            <p className="panel-hint">
              By {exported.author} · fingerprint{' '}
              <Fingerprint value={exported.digest} label="Digest" />
              {version ? ` · from ${version.title} v${version.number}` : ''}
            </p>
            <RuleFacts manifest={exported.manifest} />
            <details>
              <summary>Inspect everything being shared</summary>
              <pre>{JSON.stringify(exported, null, 2)}</pre>
            </details>
            <div className="panel-actions">
              <button type="button" className="button" onClick={() => downloadRecipe(exported)}>
                Download recipe JSON
              </button>
              {published ? (
                <span className="pill good">✓ Published</span>
              ) : (
                <button
                  type="button"
                  className="button primary"
                  disabled={!!busy}
                  onClick={() =>
                    void mutate('publish', { package: exported }, () =>
                      setNotice('This exact edition is now in your public directory.'),
                    )
                  }
                >
                  {busy === 'publish' ? 'Publishing…' : 'Publish this exact edition'}
                </button>
              )}
              {published && (
                <a
                  className="button ghost"
                  href={`/recipes#${exported.digest}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View public page ↗
                </a>
              )}
            </div>
            <p className="panel-hint">
              Publishing lists this pinned edition and a synthetic demo on your instance’s public
              directory. Listed editions never change; new editions are separate.
            </p>
          </article>
        )}
      </Step>
    </ol>
  );
}
