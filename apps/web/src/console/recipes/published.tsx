import { Fingerprint } from '../panel-kit.js';
import type { RecipeState } from './contracts.js';
import type { Mutate, RecipeAction } from './use-recipes.js';

/** Your public editions and the operator-only report queue for this directory. */
export function PublishedTab({
  state,
  busy,
  mutate,
}: {
  state: RecipeState;
  busy: RecipeAction | null;
  mutate: Mutate;
}) {
  const open = state.reports.filter((r) => r.status === 'open');
  const titleOf = (digest: string) => {
    const pack = state.publications.find((p) => p.package.digest === digest)?.package;
    return pack ? `${pack.title} · edition ${pack.revision}` : 'Unknown edition';
  };
  return (
    <div className="recipe-published">
      <section aria-labelledby="recipe-editions-heading" className="recipe-published-section">
        <div className="recipe-source-head">
          <h3 id="recipe-editions-heading">Published editions</h3>
          <a className="button small ghost" href="/recipes" target="_blank" rel="noreferrer">
            Open public directory ↗
          </a>
        </div>
        {state.publications.length === 0 ? (
          <p className="panel-hint">
            Nothing published yet. Share an approved interaction from the Share tab.
          </p>
        ) : (
          <ul className="recipe-editions">
            {[...state.publications]
              .sort(
                (a, b) =>
                  a.package.title.localeCompare(b.package.title) ||
                  b.package.revision - a.package.revision,
              )
              .map((p) => {
                const reports = state.reports.filter(
                  (r) => r.digest === p.package.digest && r.status === 'open',
                ).length;
                return (
                  <li key={p.package.digest}>
                    <span>
                      <b>{p.package.title}</b> · edition {p.package.revision}
                      <span className="panel-hint">
                        {' '}
                        · {p.package.license} · <Fingerprint value={p.package.digest} />
                      </span>
                    </span>
                    <span className="recipe-edition-state">
                      {p.withheld ? (
                        <span className="badge bad">Withheld</span>
                      ) : (
                        <span className="badge good">Listed</span>
                      )}
                      {reports > 0 && (
                        <span className="badge warn">
                          {reports} open {reports === 1 ? 'report' : 'reports'}
                        </span>
                      )}
                    </span>
                    {p.withheld && (
                      <button
                        type="button"
                        className="button small"
                        disabled={!!busy || reports > 0}
                        title={
                          reports > 0 ? 'Resolve every report for this edition first.' : undefined
                        }
                        onClick={() =>
                          void mutate('restore', { digest: p.package.digest, rightsAttested: true })
                        }
                      >
                        Restore after rights review
                      </button>
                    )}
                  </li>
                );
              })}
          </ul>
        )}
      </section>

      <section aria-labelledby="recipe-reports-heading" className="recipe-published-section">
        <div className="recipe-source-head">
          <h3 id="recipe-reports-heading">Directory moderation · {open.length} open reports</h3>
        </div>
        {state.reports.length === 0 ? (
          <p className="panel-hint">
            No reports. Viewers of your public directory can flag abuse or licensing concerns here;
            only you can withhold or restore a listing.
          </p>
        ) : (
          <ul className="recipe-reports">
            {[...state.reports]
              .sort(
                (a, b) =>
                  Number(b.status === 'open') - Number(a.status === 'open') ||
                  b.createdAt - a.createdAt,
              )
              .map((report) => (
                <li key={report.id} data-open={report.status === 'open' || undefined}>
                  <div className="recipe-report-head">
                    <b>{titleOf(report.digest)}</b>
                    <span className={`badge ${report.status === 'open' ? 'warn' : 'muted'}`}>
                      {report.status === 'open' ? 'Open' : 'Resolved'}
                    </span>
                    <time className="panel-hint">
                      {new Date(report.createdAt).toLocaleString()}
                    </time>
                  </div>
                  <blockquote>{report.reason}</blockquote>
                  {report.status === 'open' && (
                    <div className="panel-actions">
                      <button
                        type="button"
                        className="button small danger"
                        disabled={!!busy}
                        onClick={() =>
                          void mutate('moderate', { reportId: report.id, withhold: true })
                        }
                      >
                        Withhold edition and resolve
                      </button>
                      <button
                        type="button"
                        className="button small ghost"
                        disabled={!!busy}
                        onClick={() =>
                          void mutate('moderate', { reportId: report.id, withhold: false })
                        }
                      >
                        Resolve without withholding
                      </button>
                    </div>
                  )}
                </li>
              ))}
          </ul>
        )}
        <p className="panel-hint">
          Withholding removes the listing and download from the public directory. It never changes
          interactions other channels already installed.
        </p>
      </section>
    </div>
  );
}
