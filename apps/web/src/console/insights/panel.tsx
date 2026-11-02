import './panel.css';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { request } from '../../lib/api.js';
import { PanelCard, Segmented, Stat, type Tone } from '../panel-kit.js';
import {
  insightsSchema,
  RANGES,
  REASON_LABELS,
  type InsightRange,
  type Insights,
} from './contracts.js';

const percent = (value: number) => `${Math.round(value * 100)}%`;
const seconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);
const number = (value: number) => value.toLocaleString();
const toneIf = (condition: boolean, tone: Tone): { tone?: Tone } => (condition ? { tone } : {});

function timeLabel(at: number, range: Insights['range']) {
  return new Intl.DateTimeFormat(undefined, {
    ...(range.kind === '7d' ? { weekday: 'short' as const } : {}),
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);
}
function bucketName(ms: number) {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes}-minute` : `${Math.round(minutes / 60)}-hour`;
}

function status(insights: Insights | null, error: string): { text: string; tone: Tone } {
  if (error && !insights) return { text: 'Unavailable', tone: 'bad' };
  if (!insights) return { text: 'Loading…', tone: 'muted' };
  if (insights.empty) return { text: 'No data yet', tone: 'muted' };
  if (insights.takeaways.some((t) => t.tone === 'warn'))
    return { text: 'Suggestions', tone: 'warn' };
  return { text: 'Healthy', tone: 'good' };
}

/** Aggregate, privacy-aware participation and blocked-effect summaries (F30). */
export function InsightsPanel() {
  const [range, setRange] = useState<InsightRange>('stream');
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async (next: InsightRange) => {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setLoading(true);
    setError('');
    try {
      const body = await request<unknown>(
        'GET',
        `/api/insights?range=${encodeURIComponent(next)}`,
        undefined,
        c.signal,
      );
      const parsed = insightsSchema.parse((body as { insights?: unknown } | null)?.insights);
      if (!c.signal.aborted) setInsights(parsed);
    } catch (cause) {
      if (c.signal.aborted) return;
      setError(
        cause instanceof Error && cause.name !== 'ZodError'
          ? cause.message
          : 'Insights could not be read. Try again.',
      );
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load(range);
    return () => controller.current?.abort();
  }, [range, load]);
  const shown = insights?.range.kind === range ? insights : null;

  return (
    <PanelCard
      title="Insights"
      subtitle="How chat took part, and what was blocked — aggregate only, never ranked by person."
      className="insights-panel"
      status={status(shown, error)}
    >
      <div className="insights-toolbar">
        <Segmented label="Time range" value={range} options={RANGES} onChange={setRange} />
        <button
          type="button"
          className="button small ghost"
          onClick={() => void load(range)}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <p className="sr-only" role="status">
        {loading ? 'Loading insights…' : shown ? 'Insights updated.' : ''}
      </p>
      {error && (
        <div role="alert" className="answer bad insights-error">
          <p>{error}</p>
          <button type="button" className="button small" onClick={() => void load(range)}>
            Try again
          </button>
        </div>
      )}
      {!shown ? (
        !error && <p className="panel-hint">Loading insights…</p>
      ) : shown.empty ? (
        <EmptyState range={range} />
      ) : (
        <Dashboard insights={shown} />
      )}
      <p className="insights-privacy">
        Aggregate only. Groups of fewer than {shown?.minimumGroup ?? 3} people are hidden, and Riff
        never lists, ranks or scores individual viewers or what they spend.
      </p>
    </PanelCard>
  );
}

function EmptyState({ range }: { range: InsightRange }) {
  return (
    <div className="insights-empty">
      <svg viewBox="0 0 48 48" aria-hidden="true" width="40" height="40">
        <rect x="6" y="28" width="7" height="12" rx="2" />
        <rect x="20" y="18" width="7" height="22" rx="2" />
        <rect x="34" y="10" width="7" height="30" rx="2" />
      </svg>
      <div>
        <h3>No activity {range === 'stream' ? 'from a stream yet' : 'in this range yet'}</h3>
        <p>
          Once chat uses a live interaction, you will see how many people took part, how many
          actions went through, and why others were blocked — with suggestions on what to change.
        </p>
      </div>
    </div>
  );
}

function Dashboard({ insights }: { insights: Insights }) {
  const { participation: p, compiles, sessions, proposals } = insights;
  const admittedShare = p.attempts ? p.admitted / p.attempts : null;
  return (
    <div className="insights-grid">
      <dl className="panel-stats insights-kpis">
        <Stat
          label="People taking part"
          value={p.participants === null ? '< 3' : number(p.participants)}
          {...(p.participants === null ? { hint: 'Too few to show' } : {})}
        />
        <Stat
          label="Actions admitted"
          value={number(p.admitted)}
          {...toneIf(admittedShare !== null && admittedShare >= 0.7, 'good')}
          {...(admittedShare !== null
            ? { hint: `${percent(admittedShare)} of ${number(p.attempts)}` }
            : {})}
        />
        <Stat
          label="Blocked"
          value={number(p.blocked)}
          {...toneIf(p.blocked > p.admitted, 'warn')}
          {...(insights.blocked.reasons[0]
            ? { hint: `Mostly: ${insights.blocked.reasons[0].label.toLowerCase()}` }
            : {})}
        />
        <Stat
          label="Per active minute"
          value={p.perActiveMinute.toFixed(1)}
          hint={`${number(p.activeMinutes)} active minute${p.activeMinutes === 1 ? '' : 's'}`}
        />
        <Stat
          label="Generations ready"
          value={compiles.successRate === null ? '—' : percent(compiles.successRate)}
          {...toneIf(compiles.successRate !== null && compiles.successRate < 0.6, 'warn')}
          hint={`${compiles.ready} of ${compiles.total} · median ${seconds(compiles.medianMs)}`}
        />
        <Stat
          label="Incidents"
          value={number(insights.incidents.total)}
          tone={insights.incidents.total ? 'bad' : 'good'}
        />
      </dl>

      {insights.takeaways.length > 0 && (
        <section className="insights-section" aria-labelledby="insights-takeaways">
          <h3 id="insights-takeaways">What to try next</h3>
          <ul className="insights-takeaways">
            {insights.takeaways.map((t) => (
              <li key={t.text} data-tone={t.tone}>
                <span aria-hidden="true">
                  {t.tone === 'warn' ? '!' : t.tone === 'good' ? '✓' : 'i'}
                </span>
                <span>
                  <span className="sr-only">
                    {t.tone === 'warn'
                      ? 'Suggestion: '
                      : t.tone === 'good'
                        ? 'Going well: '
                        : 'Note: '}
                  </span>
                  {t.text}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ParticipationChart insights={insights} />

      {insights.blocked.reasons.length > 0 && <BlockedReasons insights={insights} />}

      {insights.automations.length > 0 && <AutomationTable insights={insights} />}

      <section className="insights-section" aria-labelledby="insights-more">
        <h3 id="insights-more">Rounds, generations and proposals</h3>
        <dl className="panel-stats">
          <Stat
            label="Rounds finished"
            value={`${sessions.finished} / ${sessions.started}`}
            hint={`${sessions.goal} goal reached · ${sessions.deadline} timed out`}
          />
          <Stat
            label="Generation time"
            value={seconds(compiles.medianMs)}
            hint={`median · 90th percentile ${seconds(compiles.p90Ms)}`}
          />
          <Stat
            label="Not generated"
            value={number(compiles.failed + compiles.unsupported)}
            hint={`${compiles.question} needed an answer · ${compiles.cancelled} cancelled`}
          />
          <Stat
            label="Chat suggestions"
            value={number(proposals.suggestions)}
            hint={
              proposals.contributors === null
                ? 'from fewer than 3 people'
                : `from ${proposals.contributors} people`
            }
          />
          <Stat
            label="Ballot votes"
            value={number(proposals.votes)}
            hint={`${proposals.ballots} ballot${proposals.ballots === 1 ? '' : 's'} · ${proposals.selections} selected`}
          />
        </dl>
      </section>
    </div>
  );
}

const W = 640;
const H = 168;
const PAD = { top: 12, right: 8, bottom: 22, left: 34 };

function ParticipationChart({ insights }: { insights: Insights }) {
  const { series } = insights.participation;
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  const max = Math.max(1, ...series.map((b) => (b.admitted ?? 0) + (b.blocked ?? 0)));
  const slot = (W - PAD.left - PAD.right) / Math.max(1, series.length);
  const barW = Math.max(2, slot - 2);
  const plotH = H - PAD.top - PAD.bottom;
  const y = (value: number) => (value / max) * plotH;
  const point = active !== null ? series[active] : undefined;
  const hidden = series.some((b) => b.suppressed);
  const ticks = [0, Math.floor(series.length / 2), series.length - 1].filter(
    (v, i, a) => v >= 0 && a.indexOf(v) === i,
  );
  const describe = (b: Insights['participation']['series'][number]) =>
    b.suppressed
      ? `${timeLabel(b.start, insights.range)}: hidden — fewer than ${insights.minimumGroup} people`
      : `${timeLabel(b.start, insights.range)}: ${b.admitted} admitted, ${b.blocked} blocked, ${b.participants} ${b.participants === 1 ? 'person' : 'people'}`;
  const peak = series.reduce<(typeof series)[number] | null>(
    (best, b) => (!b.suppressed && (b.admitted ?? 0) > (best?.admitted ?? 0) ? b : best),
    null,
  );
  return (
    <section className="insights-section" aria-labelledby={titleId}>
      <div className="insights-section-head">
        <h3 id={titleId}>Participation over time</h3>
        <ul className="insights-legend" aria-label="Legend">
          <li>
            <span className="swatch admitted" aria-hidden="true" /> Admitted
          </li>
          <li>
            <span className="swatch blocked" aria-hidden="true" /> Blocked
          </li>
          {hidden && (
            <li>
              <span className="swatch hidden" aria-hidden="true" /> Hidden (&lt;{' '}
              {insights.minimumGroup} people)
            </li>
          )}
        </ul>
      </div>
      <p className="panel-hint">
        Actions per {bucketName(insights.range.bucketMs)} interval
        {peak
          ? ` · busiest at ${timeLabel(peak.start, insights.range)} with ${peak.admitted} admitted`
          : ''}
        . Use the arrow keys on the chart to read each interval.
      </p>
      <div
        className="insights-chart"
        tabIndex={0}
        role="group"
        aria-label={`Participation chart, ${series.length} intervals. Arrow keys move between intervals.`}
        onKeyDown={(e) => {
          if (!series.length) return;
          const last = series.length - 1;
          const current = active ?? -1;
          const next =
            e.key === 'ArrowRight'
              ? Math.min(last, current + 1)
              : e.key === 'ArrowLeft'
                ? Math.max(0, current < 0 ? last : current - 1)
                : e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? last
                    : e.key === 'Escape'
                      ? null
                      : undefined;
          if (next === undefined) return;
          e.preventDefault();
          setActive(next);
        }}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          <defs>
            <pattern
              id={`${titleId}-hatch`}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1="0" y1="0" x2="0" y2="6" className="hatch" />
            </pattern>
          </defs>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line
                className="grid"
                x1={PAD.left}
                x2={W - PAD.right}
                y1={PAD.top + plotH - f * plotH}
                y2={PAD.top + plotH - f * plotH}
              />
              <text
                className="axis"
                x={PAD.left - 6}
                y={PAD.top + plotH - f * plotH + 4}
                textAnchor="end"
              >
                {Math.round(f * max)}
              </text>
            </g>
          ))}
          {series.map((b, i) => {
            const x = PAD.left + i * slot + 1;
            const base = PAD.top + plotH;
            const admitted = y(b.admitted ?? 0);
            const blocked = y(b.blocked ?? 0);
            return (
              <g key={b.start} data-active={active === i || undefined}>
                {b.suppressed ? (
                  <rect
                    className="bar hidden"
                    x={x}
                    y={base - 8}
                    width={barW}
                    height={8}
                    rx={2}
                    fill={`url(#${titleId}-hatch)`}
                  />
                ) : (
                  <>
                    {admitted > 0 && (
                      <rect
                        className="bar admitted"
                        x={x}
                        y={base - admitted}
                        width={barW}
                        height={admitted}
                        rx={Math.min(2, barW / 2)}
                      />
                    )}
                    {blocked > 0 && (
                      <rect
                        className="bar blocked"
                        x={x}
                        y={base - admitted - blocked - (admitted > 0 ? 2 : 0)}
                        width={barW}
                        height={blocked}
                        rx={Math.min(2, barW / 2)}
                      />
                    )}
                  </>
                )}
                <rect
                  className="hit"
                  x={PAD.left + i * slot}
                  y={PAD.top}
                  width={slot}
                  height={plotH}
                  onMouseEnter={() => setActive(i)}
                />
              </g>
            );
          })}
          <line
            className="baseline"
            x1={PAD.left}
            x2={W - PAD.right}
            y1={PAD.top + plotH}
            y2={PAD.top + plotH}
          />
          {ticks.map((i) => (
            <text
              key={i}
              className="axis"
              x={PAD.left + i * slot + slot / 2}
              y={H - 6}
              textAnchor={i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'}
            >
              {series[i] ? timeLabel(series[i].start, insights.range) : ''}
            </text>
          ))}
        </svg>
        {point && active !== null && (
          <div
            className="insights-tooltip"
            style={{ left: `${((PAD.left + active * slot + slot / 2) / W) * 100}%` }}
            aria-live="polite"
          >
            {describe(point)}
          </div>
        )}
      </div>
      <details className="insights-table-toggle">
        <summary>Show chart data as a table</summary>
        <table className="insights-table">
          <caption className="sr-only">Participation per interval</caption>
          <thead>
            <tr>
              <th scope="col">Interval starting</th>
              <th scope="col">Admitted</th>
              <th scope="col">Blocked</th>
              <th scope="col">People</th>
            </tr>
          </thead>
          <tbody>
            {series
              .filter((b) => b.suppressed || (b.admitted ?? 0) + (b.blocked ?? 0) > 0)
              .map((b) => (
                <tr key={b.start}>
                  <th scope="row">{timeLabel(b.start, insights.range)}</th>
                  {b.suppressed ? (
                    <td colSpan={3}>Hidden — fewer than {insights.minimumGroup} people</td>
                  ) : (
                    <>
                      <td>{b.admitted}</td>
                      <td>{b.blocked}</td>
                      <td>{b.participants}</td>
                    </>
                  )}
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

function BlockedReasons({ insights }: { insights: Insights }) {
  const max = Math.max(1, ...insights.blocked.reasons.map((r) => r.count));
  return (
    <section className="insights-section" aria-labelledby="insights-blocked">
      <h3 id="insights-blocked">Why actions were blocked</h3>
      <ul className="insights-bars">
        {insights.blocked.reasons.map((r) => (
          <li key={r.reason}>
            <span className="insights-bar-label">{r.label}</span>
            <span className="insights-bar-track" aria-hidden="true">
              <span
                className="insights-bar-fill"
                style={{ transform: `scaleX(${r.count / max})` }}
              />
            </span>
            <span className="insights-bar-value">
              {number(r.count)}
              <span className="sr-only">
                {' '}
                of {number(insights.blocked.total)} blocked (
                {percent(r.count / insights.blocked.total)})
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AutomationTable({ insights }: { insights: Insights }) {
  return (
    <section className="insights-section" aria-labelledby="insights-automations">
      <h3 id="insights-automations">By interaction</h3>
      <div className="insights-scroll">
        <table className="insights-table">
          <thead>
            <tr>
              <th scope="col">Interaction</th>
              <th scope="col">Triggers</th>
              <th scope="col">Admitted</th>
              <th scope="col">Blocked</th>
              <th scope="col">Main block reason</th>
              <th scope="col">People</th>
              <th scope="col">Incidents</th>
            </tr>
          </thead>
          <tbody>
            {insights.automations.map((a) => {
              const top = a.reasons[0];
              return (
                <tr key={a.automationId}>
                  <th scope="row">{a.title}</th>
                  <td>{number(a.triggers)}</td>
                  <td>
                    <span className="insights-split" aria-hidden="true">
                      <span style={{ flexGrow: a.admitted }} className="admitted" />
                      <span style={{ flexGrow: a.blocked }} className="blocked" />
                    </span>
                    {number(a.admitted)}
                  </td>
                  <td>{number(a.blocked)}</td>
                  <td>{top ? `${REASON_LABELS[top.reason] ?? top.reason} (${top.count})` : '—'}</td>
                  <td>{a.participants === null ? '< 3' : a.participants}</td>
                  <td data-bad={a.incidents > 0 || undefined}>{a.incidents}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
