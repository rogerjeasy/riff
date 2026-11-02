import '../panel-kit.css';
import './recipes.css';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { request } from '../../lib/api.js';
import { publicationSchema, downloadRecipe, type RecipePublication } from './contracts.js';
import { RecipePreview } from './preview.js';
import { RuleFacts } from './rules.js';
import { installLinkFor } from './install-link.js';

const digestFromHash = () => {
  const value = window.location.hash.slice(1);
  return /^[a-f0-9]{64}$/.test(value) ? value : '';
};

/** Public, read-only directory of this instance's published recipe editions. */
export function RecipeDirectory() {
  const [recipes, setRecipes] = useState<RecipePublication[] | null>(null);
  const [selected, setSelected] = useState<RecipePublication | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [report, setReport] = useState('');
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState('');
  const serial = useRef(0);
  const detail = useRef<HTMLElement>(null);

  async function search(value: string) {
    const id = ++serial.current;
    try {
      const result = z
        .object({ recipes: z.array(publicationSchema).max(20) })
        .parse(await request('GET', `/directory/recipes?q=${encodeURIComponent(value)}`));
      if (serial.current === id) {
        setRecipes(result.recipes);
        setError('');
      }
    } catch (e) {
      if (serial.current === id)
        setError(e instanceof Error ? e.message : 'Directory unavailable.');
    }
  }
  async function open(digest: string, focus = true) {
    const id = ++serial.current;
    try {
      const result = z
        .object({ recipe: publicationSchema })
        .parse(await request('GET', `/directory/recipes/${digest}`));
      if (serial.current === id) {
        setSelected(result.recipe);
        setReport('');
        setSent(false);
        setError('');
        if (window.location.hash.slice(1) !== digest) history.replaceState(null, '', `#${digest}`);
        if (focus) requestAnimationFrame(() => detail.current?.focus());
      }
    } catch (e) {
      if (serial.current === id)
        setError(e instanceof Error ? e.message : 'This edition is unavailable.');
    }
  }
  useEffect(() => {
    document.title = 'Riff recipe directory';
    void search('').then(() => {
      const linked = digestFromHash();
      if (linked) void open(linked, false);
    });
    return () => {
      serial.current++;
    };
  }, []);
  // Search as the visitor types, after a short pause.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => void search(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const recipe = selected?.package;
  return (
    <main className="recipe-directory">
      <header className="recipe-directory-hero">
        <a href="/">← Creator console</a>
        <p className="step-label">Riff recipes</p>
        <h1>Interactions other streamers made, ready to remix</h1>
        <p>
          Watch a synthetic demo, read the exact rules and code, then download a pinned edition and
          review it in your own channel. Nothing here can run on your stream by itself.
        </p>
        <form
          className="recipe-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            void search(query.trim());
          }}
        >
          <label className="sr-only" htmlFor="recipe-search">
            Search published recipes
          </label>
          <input
            id="recipe-search"
            type="search"
            value={query}
            maxLength={80}
            placeholder="Search by title, author or description"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="button">Search</button>
        </form>
      </header>
      {error && (
        <p role="alert" className="answer bad">
          {error}
        </p>
      )}
      <div className="recipe-directory-body">
        <section aria-label="Search results">
          {recipes === null ? (
            <p className="panel-hint">Loading recipes…</p>
          ) : recipes.length === 0 ? (
            <p className="recipe-empty">
              {query
                ? `No published recipes match “${query}”.`
                : 'No recipes are published here yet.'}
            </p>
          ) : (
            <ul className="recipe-list">
              {recipes.map((item) => (
                <li key={item.package.digest}>
                  <button
                    type="button"
                    className="recipe-card"
                    aria-current={item.package.digest === recipe?.digest}
                    aria-label={`Open ${item.package.title}`}
                    onClick={() => void open(item.package.digest)}
                  >
                    <span className="recipe-card-title">{item.package.title}</span>
                    <span className="recipe-card-desc">{item.package.description}</span>
                    <span className="recipe-card-meta">
                      <span>{item.package.author}</span>·
                      <span>edition {item.package.revision}</span>
                      <span className="badge">{item.package.license}</span>
                      {item.package.lineage.length > 0 && (
                        <span className="badge muted">Remix</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {recipe && selected ? (
          <section
            ref={detail}
            tabIndex={-1}
            className="card recipe-detail"
            aria-label="Published recipe"
          >
            <div className="recipe-source-head">
              <h2>
                {recipe.title} · edition {recipe.revision}
              </h2>
              <span className="recipe-detail-actions">
                <a
                  className="button primary"
                  href={installLinkFor(window.location.origin, recipe.digest)}
                >
                  Install in my console
                </a>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    const link = installLinkFor(window.location.origin, recipe.digest);
                    void (navigator.clipboard?.writeText(link) ?? Promise.reject(new Error())).then(
                      () => setCopied(recipe.digest),
                      () => setError(`Copy failed. Install link: ${link}`),
                    );
                  }}
                >
                  Copy install link
                </button>
                <button className="button ghost" onClick={() => downloadRecipe(recipe)}>
                  Download pinned recipe
                </button>
              </span>
            </div>
            {copied === recipe.digest && (
              <p role="status" className="panel-hint">
                Install link copied. It opens a guided install pinned to this exact edition.
              </p>
            )}
            <p>{recipe.description}</p>
            <p className="panel-hint">
              Publisher-declared author: {recipe.author} · License: {recipe.license}. Riff has not
              verified the publisher’s identity.
            </p>
            <RuleFacts manifest={recipe.manifest} />
            <RecipePreview
              proof={selected.proof}
              scene={recipe.scene}
              reducedMotion={recipe.presentation.reducedMotion}
              highContrast={recipe.presentation.highContrast}
              effectLabels={recipe.presentation.effectLabels}
            />
            {recipe.lineage.length > 0 && (
              <p className="panel-hint">
                Remixed from{' '}
                {recipe.lineage
                  .map((l) => `${l.author} (edition ${l.revision}, ${l.license})`)
                  .join(' → ')}
                .
              </p>
            )}
            <p className="panel-callout">
              To use it: open the install link in your Riff console. It checks the pinned digest,
              compatibility and authority before anything is saved. Another Riff installation can
              download the file and choose it from the same link. Installs never activate an
              interaction or grant permissions; Twitch chat participation needs only{' '}
              <code>user:read:chat</code>. Built-in artwork comes from your own Riff installation
              under its project license.
            </p>
            <details>
              <summary>Source code, rules and lineage</summary>
              <pre>
                {JSON.stringify(
                  {
                    source: recipe.source,
                    manifest: recipe.manifest,
                    lineage: recipe.lineage,
                    presentation: recipe.presentation,
                    digest: recipe.digest,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            <details>
              <summary>Report abuse or a licensing concern</summary>
              <form
                className="recipe-report-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  setSending(true);
                  void request('POST', `/directory/recipes/${recipe.digest}/report`, {
                    reason: report,
                  })
                    .then(
                      () => {
                        setSent(true);
                        setError('');
                      },
                      (e: unknown) =>
                        setError(e instanceof Error ? e.message : 'Report could not be sent.'),
                    )
                    .finally(() => setSending(false));
                }}
              >
                <label>
                  Report abuse or licensing concern
                  <textarea
                    value={report}
                    minLength={8}
                    maxLength={500}
                    rows={3}
                    disabled={sent}
                    onChange={(e) => setReport(e.target.value)}
                  />
                  <span className="panel-hint">
                    {report.trim().length < 8 ? 'At least 8 characters.' : `${report.length}/500`}{' '}
                    Goes only to this directory’s operator.
                  </span>
                </label>
                <button
                  className="button small ghost"
                  disabled={report.trim().length < 8 || sent || sending}
                >
                  Send report to this directory
                </button>
                {sent && <p role="status">Report received by this directory’s operator.</p>}
              </form>
            </details>
          </section>
        ) : (
          recipes &&
          recipes.length > 0 && (
            <p className="recipe-empty">Choose a recipe to watch its demo and read its rules.</p>
          )
        )}
      </div>
    </main>
  );
}
