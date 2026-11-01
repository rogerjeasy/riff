import './recipes.css';
import { useState } from 'react';
import type { Version } from '../../lib/types.js';
import { PanelCard, Tabs, type Tone } from '../panel-kit.js';
import type { RecipeState } from './contracts.js';
import { PublishedTab } from './published.js';
import { RemixTab } from './remix.js';
import { ShareTab } from './share.js';
import { useRecipes } from './use-recipes.js';

type Tab = 'remix' | 'share' | 'published';

function summary(state: RecipeState | null): { text: string; tone: Tone } {
  if (!state) return { text: 'Loading…', tone: 'muted' };
  const open = state.reports.filter((r) => r.status === 'open').length;
  if (open) return { text: `${open} open ${open === 1 ? 'report' : 'reports'}`, tone: 'warn' };
  const parts = [
    state.imports.length && `${state.imports.length} imported`,
    state.publications.length && `${state.publications.length} published`,
  ].filter(Boolean);
  return parts.length
    ? { text: parts.join(' · '), tone: 'private' }
    : { text: 'Empty', tone: 'muted' };
}

export function RecipeLibrary({
  versions,
  onReview,
}: {
  versions: Version[];
  onReview: (id: string) => void;
}) {
  const recipes = useRecipes();
  const { state, busy, error, notice } = recipes;
  const [tab, setTab] = useState<Tab>('remix');
  const open = state?.reports.filter((r) => r.status === 'open').length ?? 0;
  return (
    <PanelCard
      title="Recipe library"
      subtitle="Remix other creators’ interactions and share your own — credits intact, nothing goes live without your approval."
      status={summary(state)}
      className="recipe-library"
    >
      {!state ? (
        error ? (
          <p role="alert" className="answer bad">
            {error}
          </p>
        ) : (
          <p className="panel-hint">Loading your recipes…</p>
        )
      ) : (
        <Tabs
          label="Recipe library sections"
          value={tab}
          onChange={setTab}
          tabs={[
            {
              value: 'remix',
              label: 'Remix into my channel',
              badge: state.imports.length ? (
                <span className="panel-count">{state.imports.length}</span>
              ) : null,
            },
            { value: 'share', label: 'Share an interaction' },
            {
              value: 'published',
              label: 'Published',
              badge:
                open > 0 ? (
                  <span className="panel-count" data-tone="warn">
                    {open}
                  </span>
                ) : state.publications.length ? (
                  <span className="panel-count">{state.publications.length}</span>
                ) : null,
            },
          ]}
        >
          {/* Panels stay mounted so unsaved edits survive switching tabs. */}
          <div hidden={tab !== 'remix'}>
            <RemixTab
              state={state}
              busy={busy}
              mutate={recipes.mutate}
              setError={recipes.setError}
              setNotice={recipes.setNotice}
              versions={versions}
              onReview={onReview}
            />
          </div>
          <div hidden={tab !== 'share'}>
            <ShareTab
              state={state}
              busy={busy}
              mutate={recipes.mutate}
              setNotice={recipes.setNotice}
              versions={versions}
            />
          </div>
          <div hidden={tab !== 'published'}>
            <PublishedTab state={state} busy={busy} mutate={recipes.mutate} />
          </div>
        </Tabs>
      )}
      {state && error && (
        <p role="alert" className="answer bad">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="panel-callout" data-tone="good">
          {notice}
        </p>
      )}
    </PanelCard>
  );
}
