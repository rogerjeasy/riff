import '../panel-kit.css';
import './recipes.css';
import './install.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiError, request } from '../../lib/api.js';
import { Fingerprint, Step } from '../panel-kit.js';
import { proofSchema, recipePackageSchema } from './contracts.js';
import { RecipePreview } from './preview.js';
import type { InstallLink } from './install-link.js';

/** F27 guided install: pinned edition → compatibility → authority → preview → private candidate. */
const MAX_BYTES = 131_072;
const checkSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['ok', 'blocked', 'consent', 'warn']),
  detail: z.string(),
  grantUrl: z.string().startsWith('/auth/twitch').optional(),
});
export const installPreviewSchema = z.object({
  package: recipePackageSchema,
  source: z.enum(['directory', 'file']),
  proof: proofSchema.nullable(),
  profileRevision: z.number().int().nonnegative(),
  compatibility: z.object({
    installable: z.boolean(),
    sdkVersion: z.string(),
    checks: z.array(checkSchema).max(40),
  }),
  scope: z
    .array(
      z.object({
        field: z.string(),
        label: z.string(),
        before: z.string().nullable(),
        after: z.string(),
        changed: z.boolean(),
      }),
    )
    .max(20),
  existing: z.object({
    status: z.enum(['none', 'imported', 'installed', 'other-revision']),
    versionId: z.string().nullable(),
    title: z.string().nullable(),
    revision: z.number().nullable(),
  }),
});
export type InstallPreview = z.infer<typeof installPreviewSchema>;

type Phase =
  | { kind: 'needs-file' }
  | { kind: 'loading' }
  | { kind: 'failed'; title: string; message: string }
  | { kind: 'ready'; preview: InstallPreview }
  | { kind: 'installing'; preview: InstallPreview }
  | { kind: 'installed'; preview: InstallPreview; versionId: string; already: boolean };

function failure(error: unknown): { title: string; message: string } {
  const message = error instanceof Error ? error.message : 'The install could not be checked.';
  if (error instanceof ApiError) {
    if (error.status === 404) return { title: 'Recipe unavailable', message };
    if (/digest/i.test(message)) return { title: 'Digest mismatch', message };
    if (error.code === 'UNSUPPORTED') return { title: 'Not compatible with this channel', message };
    if (error.code === 'STALE') return { title: 'Your recipe profile changed', message };
  }
  return { title: 'Install stopped', message };
}

const STATUS: Record<z.infer<typeof checkSchema>['status'], { icon: string; text: string }> = {
  ok: { icon: '✓', text: 'Ready' },
  warn: { icon: '!', text: 'Check' },
  consent: { icon: '!', text: 'Needs consent' },
  blocked: { icon: '✕', text: 'Blocks install' },
};

export function RecipeInstall({
  link,
  onClose,
  onInstalled,
  onReview,
}: {
  link: InstallLink;
  /** Leaves the flow; nothing was saved unless an install already finished. */
  onClose: () => void;
  onInstalled: () => void;
  onReview: (versionId: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>(
    link.kind === 'remote' ? { kind: 'needs-file' } : { kind: 'loading' },
  );
  const [file, setFile] = useState<{ name: string; value: unknown } | null>(null);
  const [asUpdate, setAsUpdate] = useState(true);
  const epoch = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const digest = link.kind === 'invalid' ? '' : link.digest;

  const load = useCallback(
    async (supplied?: unknown) => {
      if (!digest) return;
      const n = ++epoch.current;
      setPhase({ kind: 'loading' });
      try {
        const raw = await request<unknown>('POST', '/api/recipes/install-preview', {
          digest,
          ...(supplied !== undefined ? { package: supplied } : {}),
        });
        const preview = z.object({ preview: installPreviewSchema }).parse(raw).preview;
        if (epoch.current === n) setPhase({ kind: 'ready', preview });
      } catch (error) {
        if (epoch.current === n) setPhase({ kind: 'failed', ...failure(error) });
      }
    },
    [digest],
  );
  useEffect(() => {
    if (link.kind === 'local') void load();
    requestAnimationFrame(() => heading.current?.focus());
    return () => {
      epoch.current++;
    };
  }, [link.kind, load]);

  async function install(preview: InstallPreview) {
    const n = ++epoch.current;
    setPhase({ kind: 'installing', preview });
    const target =
      asUpdate && preview.existing.status === 'other-revision' ? preview.existing.versionId : null;
    try {
      const raw = await request<unknown>('POST', '/api/recipes/install-link', {
        digest,
        profileRevision: preview.profileRevision,
        ...(file ? { package: file.value } : {}),
        ...(target ? { targetVersionId: target } : {}),
      });
      const installed = z
        .object({ installed: z.object({ versionId: z.string(), alreadyInstalled: z.boolean() }) })
        .parse(raw).installed;
      if (epoch.current !== n) return;
      setPhase({
        kind: 'installed',
        preview,
        versionId: installed.versionId,
        already: installed.alreadyInstalled,
      });
      onInstalled();
    } catch (error) {
      if (epoch.current === n) setPhase({ kind: 'failed', ...failure(error) });
    }
  }

  function readFile(chosen: File | undefined) {
    if (!chosen) return;
    if (chosen.size > MAX_BYTES) {
      setPhase({
        kind: 'failed',
        title: 'File too large',
        message: 'Recipe files are at most 128 KiB. Download the pinned edition again.',
      });
      return;
    }
    void chosen.text().then((text) => {
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        setPhase({
          kind: 'failed',
          title: 'Not a recipe file',
          message: 'That file is not recipe JSON. Choose the file you downloaded.',
        });
        return;
      }
      setFile({ name: chosen.name, value });
      void load(value);
    });
  }

  const preview = 'preview' in phase ? phase.preview : null;
  const pack = preview?.package;
  const blocked = preview?.compatibility.checks.filter((c) => c.status === 'blocked') ?? [];
  const consent = preview?.compatibility.checks.filter((c) => c.status === 'consent') ?? [];
  const existing = preview?.existing;
  const installedId = existing?.versionId ?? null;
  const busy = phase.kind === 'installing' || phase.kind === 'loading';
  return (
    <section className="card recipe-install" aria-labelledby="recipe-install-heading">
      <header className="recipe-install-head">
        <div>
          <p className="step-label">Install link</p>
          <h2 id="recipe-install-heading" ref={heading} tabIndex={-1}>
            {pack ? `Install “${pack.title}”` : 'Install this interaction'}
          </h2>
          <p className="panel-hint">
            Check everything before anything is saved. Installing creates a private candidate;
            nothing goes live until you approve that exact version.
          </p>
        </div>
        {phase.kind !== 'installed' && (
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
        )}
      </header>

      {link.kind === 'invalid' && (
        <p role="alert" className="panel-callout" data-tone="warn">
          {link.message}
        </p>
      )}

      {link.kind === 'remote' && phase.kind !== 'installed' && (
        <div className="panel-callout">
          <p>
            This link comes from another Riff directory, <b>{link.from}</b>. Riff never downloads
            from other sites for you: open that directory, download the pinned edition, then choose
            the file here. It must match digest <Fingerprint value={link.digest} label="Digest" />.
          </p>
          <div className="panel-actions">
            <a
              className="button small"
              href={`${link.from}/recipes#${link.digest}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open that directory
            </a>
            <label className="button small primary">
              {file ? `Chosen: ${file.name}` : 'Choose downloaded file'}
              <input
                type="file"
                className="sr-only"
                accept=".json,application/json"
                onChange={(e) => readFile(e.target.files?.[0])}
              />
            </label>
          </div>
        </div>
      )}

      {phase.kind === 'loading' && (
        <p role="status" className="panel-hint">
          Fetching the pinned edition and checking its digest…
        </p>
      )}

      {phase.kind === 'failed' && (
        <div role="alert" className="panel-callout" data-tone="warn">
          <b>{phase.title}.</b> {phase.message} Nothing was saved.
          <div className="panel-actions">
            {link.kind === 'local' && (
              <button type="button" className="button small" onClick={() => void load()}>
                Check again
              </button>
            )}
            <button type="button" className="button small ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      )}

      {preview && pack && (
        <ol className="panel-steps">
          <Step title="Pinned edition" done>
            <dl className="recipe-facts">
              <div>
                <dt>Author</dt>
                <dd>
                  {pack.author}{' '}
                  <span className="panel-hint">(publisher-declared, not verified)</span>
                </dd>
              </div>
              <div>
                <dt>Edition</dt>
                <dd>
                  {pack.revision} · <Fingerprint value={pack.digest} label="Digest" />{' '}
                  <span className="badge good">digest verified</span>
                </dd>
              </div>
              <div>
                <dt>License</dt>
                <dd>
                  <span className="badge">{pack.license}</span> for code and copy; built-in artwork
                  stays under your installation’s license.
                </dd>
              </div>
              <div>
                <dt>Lineage</dt>
                <dd>
                  {pack.lineage.length
                    ? pack.lineage
                        .map((l) => `${l.author} (edition ${l.revision}, ${l.license})`)
                        .join(' → ')
                    : 'Original edition'}
                </dd>
              </div>
              <div>
                <dt>From</dt>
                <dd>
                  {preview.source === 'directory' ? 'This Riff directory' : 'The file you chose'}
                </dd>
              </div>
            </dl>
            <p>{pack.description}</p>
          </Step>

          <Step
            title="Compatibility with this channel"
            done={preview.compatibility.installable && !consent.length}
            current={!preview.compatibility.installable}
            aside={<span className="panel-hint">SDK {preview.compatibility.sdkVersion}</span>}
          >
            <ul className="recipe-install-checks" aria-label="Compatibility checks">
              {preview.compatibility.checks.map((check) => (
                <li key={check.id} data-status={check.status}>
                  <span aria-hidden="true">{STATUS[check.status].icon}</span>
                  <span>
                    <b>{check.label}</b>{' '}
                    <span className="sr-only">{STATUS[check.status].text}: </span>
                    {check.detail}{' '}
                    {check.grantUrl && (
                      // A new tab keeps this review open; recheck after granting.
                      <a href={check.grantUrl} target="_blank" rel="noopener noreferrer">
                        {check.status === 'consent' ? 'Grant on Twitch' : 'Connect Twitch'}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {consent.length > 0 && (
              <p className="panel-hint">
                Missing consent does not block a private candidate, but it cannot act on your
                channel until you grant it.
              </p>
            )}
            <div className="panel-actions">
              <button
                type="button"
                className="button small ghost"
                disabled={busy}
                onClick={() => void load(file?.value)}
              >
                Recheck compatibility
              </button>
            </div>
          </Step>

          <Step
            title={
              existing?.status === 'installed' || existing?.status === 'other-revision'
                ? `What changes compared with your installed edition ${existing.revision ?? ''}`
                : 'What it would be allowed to do'
            }
            done
          >
            <table className="recipe-install-scope">
              <caption className="sr-only">
                Authority before and after installing this edition
              </caption>
              <thead>
                <tr>
                  <th scope="col">Scope</th>
                  <th scope="col">Now</th>
                  <th scope="col">After install</th>
                </tr>
              </thead>
              <tbody>
                {preview.scope.map((row) => (
                  <tr key={row.field} data-changed={row.changed || undefined}>
                    <th scope="row">{row.label}</th>
                    <td>{row.before ?? 'Nothing installed'}</td>
                    <td>
                      {row.after}
                      {row.changed && row.before !== null && (
                        <span className="badge warn"> changed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Step>

          <Step title="Private preview" done={!!preview.proof}>
            {preview.proof ? (
              <RecipePreview
                proof={preview.proof}
                scene={pack.scene}
                reducedMotion={pack.presentation.reducedMotion}
                highContrast={pack.presentation.highContrast}
                effectLabels={pack.presentation.effectLabels}
              />
            ) : (
              <p className="panel-hint">
                No published demo comes with a file. Installing runs a private synthetic rehearsal
                first; nothing is shown on stream.
              </p>
            )}
            <p className="panel-hint">
              After install, open the candidate to rehearse it privately with your own scenarios.
            </p>
          </Step>
        </ol>
      )}

      {existing?.status === 'installed' && phase.kind === 'ready' && existing.versionId && (
        <div className="panel-callout" role="status">
          This edition is already installed as <b>{existing.title}</b>. Open it to review or
          approve, or compare above.
          <div className="panel-actions">
            <button
              type="button"
              className="button small primary"
              onClick={() => installedId && onReview(installedId)}
            >
              Open installed candidate
            </button>
          </div>
        </div>
      )}
      {existing?.status === 'other-revision' && phase.kind === 'ready' && (
        <label className="recipe-install-update">
          <input
            type="checkbox"
            checked={asUpdate}
            onChange={(e) => setAsUpdate(e.target.checked)}
          />
          Install as an update to <b>{existing.title}</b> (edition {existing.revision}). Unchecked,
          it installs as a separate interaction.
        </label>
      )}

      {phase.kind === 'installed' ? (
        <div className="panel-callout" data-tone="good" role="status">
          {phase.already
            ? 'This edition was already installed. Nothing new was saved.'
            : 'Installed as a private candidate after verification and a synthetic rehearsal. Nothing is live.'}{' '}
          Review its behavior and approve the exact version to activate it.
          <div className="panel-actions">
            <button
              type="button"
              className="button small primary"
              onClick={() => onReview(phase.versionId)}
            >
              Open candidate for review
            </button>
            <button type="button" className="button small ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      ) : (
        preview &&
        existing?.status !== 'installed' && (
          <div className="panel-actions">
            <button
              type="button"
              className="button primary"
              disabled={busy || !preview.compatibility.installable}
              onClick={() => void install(preview)}
            >
              {phase.kind === 'installing'
                ? 'Verifying and rehearsing privately…'
                : 'Install as private candidate'}
            </button>
            <button type="button" className="button ghost" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <span className="panel-hint" role={blocked.length ? 'alert' : undefined}>
              {blocked.length
                ? `${blocked.length} ${blocked.length === 1 ? 'check blocks' : 'checks block'} this install.`
                : 'Runs the normal verification and rehearsal; activation still needs your approval.'}
            </span>
          </div>
        )
      )}
    </section>
  );
}
