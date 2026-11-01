import { useState } from 'react';
import type { Automation } from '../lib/types.js';
import { api } from '../lib/api.js';
import { Evidence } from '../console/review/evidence.js';
/** Reuse the full reviewed-artifact gate; dock actions never introduce another approval path. */
export function DockReviews({
  automations,
  panic,
  refresh,
  notify,
}: {
  automations: Automation[];
  panic: boolean;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const candidates = automations.flatMap((a) => a.versions.filter((v) => v.status === 'candidate'));
  const [selected, setSelected] = useState('');
  const version = candidates.find((v) => v.id === selected) ?? candidates[0];
  const automation = version ? automations.find((a) => a.id === version.automationId) : undefined;
  if (!version) return <p className="note">No candidates waiting for review.</p>;
  return (
    <details className="dock-review">
      <summary>Review candidates · {candidates.length}</summary>
      <label>
        Candidate version
        <select value={version.id} onChange={(e) => setSelected(e.target.value)}>
          {candidates.map((v) => (
            <option key={v.id} value={v.id}>
              {v.title} v{v.number}
            </option>
          ))}
        </select>
      </label>
      <Evidence
        version={version}
        automation={automation}
        panic={panic}
        previewed={false}
        onTransitioned={async (message) => {
          notify(message);
          await refresh();
        }}
        onApprove={async (v, reset) => {
          try {
            await api.approve(v.id, v.artifactId ?? '', automation?.activeVersionId ?? null, reset);
            notify('The exact reviewed version is live.');
          } catch (e) {
            notify(e instanceof Error ? e.message : 'Approval failed.');
          } finally {
            await refresh();
          }
        }}
        onDiscard={async (v) => {
          try {
            await api.discard(v.id);
            notify('Candidate discarded.');
          } catch (e) {
            notify(e instanceof Error ? e.message : 'Could not discard.');
          } finally {
            await refresh();
          }
        }}
      />
    </details>
  );
}
