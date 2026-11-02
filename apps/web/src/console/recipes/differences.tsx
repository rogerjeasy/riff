import type { RecipeReview } from './contracts.js';

const FIELD_LABEL: Record<string, string> = {
  trigger: 'Chat command and limits',
  capabilities: 'Capabilities',
  experience: 'Round rules',
  source: 'Code',
  scene: 'Screen layout',
  presentation: 'Language, motion and name',
  style: 'Accent color and headline',
};
const parse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const short = (value: unknown) => {
  if (value === undefined || value === null) return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
};

/** Key-level changes for structured fields so a creator sees "command: !tomato → !splat". */
function keyChanges(before: unknown, after: unknown) {
  if (!isRecord(before) || !isRecord(after)) return null;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({ key, before: before[key], after: after[key] }));
}

/** Changed fields first with exact before/after; unchanged fields collapse into one line. */
export function Differences({ differences }: { differences: RecipeReview['differences'] }) {
  const changed = differences.filter((d) => d.before !== d.after);
  const same = differences.filter((d) => d.before === d.after);
  return (
    <div className="recipe-diff">
      {changed.length === 0 && <p className="panel-hint">No differences from the source.</p>}
      <ul className="recipe-diff-list">
        {changed.map((difference, index) => {
          const before = parse(difference.before),
            after = parse(difference.after);
          const keys = difference.field === 'scene' ? null : keyChanges(before, after);
          const label = FIELD_LABEL[difference.field] ?? difference.field;
          return (
            <li key={`${difference.field}-${index}`}>
              <h5>{label}</h5>
              {keys ? (
                <table className="recipe-diff-table">
                  <caption className="sr-only">{label} changes</caption>
                  <thead>
                    <tr>
                      <th scope="col">Field</th>
                      <th scope="col">Source</th>
                      <th scope="col">Proposed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((change) => (
                      <tr key={change.key}>
                        <th scope="row">{change.key}</th>
                        <td>
                          <del>{short(change.before)}</del>
                        </td>
                        <td>
                          <ins>{short(change.after)}</ins>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <details>
                  <summary>
                    {difference.field === 'source'
                      ? 'The code was rewritten for your channel — inspect both versions'
                      : 'Changed — inspect source and proposed values'}
                  </summary>
                  <div className="recipe-diff-pair">
                    <div>
                      <h6>Source</h6>
                      <pre>{pretty(difference.before)}</pre>
                    </div>
                    <div>
                      <h6>Proposed</h6>
                      <pre>{pretty(difference.after)}</pre>
                    </div>
                  </div>
                </details>
              )}
            </li>
          );
        })}
      </ul>
      {same.length > 0 && (
        <p className="panel-hint">
          Unchanged: {same.map((d) => FIELD_LABEL[d.field] ?? d.field).join(', ')}.
        </p>
      )}
    </div>
  );
}
function pretty(text: string) {
  const value = parse(text);
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
