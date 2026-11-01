import type { DecisionCode } from '@riff/sdk';
import type { DatabaseConnection } from '../../db/client.js';
import { insightsRepository } from '../../db/repositories/insights.js';
import {
  MAX_BUCKETS,
  MIN_GROUP,
  REASON_LABEL,
  REASON_OF,
  STREAM_GAP_MS,
  STREAM_MAX_MS,
  type BlockedReason,
  type InsightRange,
  type Insights,
} from './contract.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NICE_BUCKETS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((m) => m * MINUTE);
const TERMINAL = new Set(['ready', 'question', 'unsupported', 'failed']);

/** Counts below the minimum group size are withheld so no individual is singled out. */
const atLeastGroup = (value: number) => (value >= MIN_GROUP ? value : value === 0 ? 0 : null);
const reasonOf = (code: string): BlockedReason =>
  REASON_OF[code as Exclude<DecisionCode, 'ACCEPTED' | 'UNRELATED'>] ?? 'error';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null;
}
function median(sorted: number[]) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 ? upper : Math.round(((sorted[mid - 1] ?? upper) + upper) / 2);
}

const ADVICE: Record<BlockedReason, string> = {
  'viewer-limit': 'consider raising it if chat wants to play more',
  'channel-budget': 'consider a larger effect budget or a slower cadence',
  role: 'consider opening it to more viewers or saying on stream who can play',
  finished: 'consider a longer round or announcing the next one',
  paused: 'resume sooner, or tell chat when it is paused',
  resources: 'consider more actions per player',
  join: 'make the join command clearer on stream',
  'participant-cap': 'consider allowing more participants',
  duplicate: 'these were redelivered events and safely ignored',
  capacity: 'the gameplay queue was full; consider a lower command cadence',
  mechanics:
    'these were blocked by the round mechanics, as designed; check the rules are clear on stream',
  error: 'review the activity feed for details',
};

/**
 * Privacy-aware aggregate insights (F30). Only counts, rates and durations are returned,
 * all tenant-scoped; groups smaller than MIN_GROUP are suppressed, and there is no
 * per-viewer list, leaderboard or spending ranking of any kind.
 */
export function createInsightsService(options: {
  database: DatabaseConnection;
  channelId: string;
  now?: () => number;
}) {
  const repo = insightsRepository(options.database, options.channelId);
  const now = options.now ?? Date.now;

  function window(kind: InsightRange, at: number): { from: number; to: number } {
    // Half-open [from, to) windows that still include events stamped exactly `now`.
    if (kind === '24h') return { from: at + 1 - 24 * HOUR, to: at + 1 };
    if (kind === '7d') return { from: at + 1 - 7 * 24 * HOUR, to: at + 1 };
    const latest = repo.latestDecisionAt();
    if (latest === null) return { from: at, to: at };
    // Walk back from the latest decision until a gap longer than STREAM_GAP_MS.
    let from = latest;
    for (const time of repo.decisionTimes(latest - STREAM_MAX_MS, latest)) {
      if (from - time > STREAM_GAP_MS) break;
      from = time;
    }
    return { from, to: Math.min(at + 1, latest + STREAM_GAP_MS) };
  }

  function summary(kind: InsightRange): Insights {
    const at = now();
    const { from, to } = window(kind, at);
    const span = Math.max(1, to - from);
    const bucketMs = NICE_BUCKETS.find((size) => span / size <= MAX_BUCKETS) ?? 1440 * MINUTE;

    const totals = repo.totals(from, to);
    const rows = new Map(repo.buckets(from, to, bucketMs).map((row) => [row.bucket, row]));
    const series: Insights['participation']['series'] = [];
    for (let i = 0; i * bucketMs < span && series.length <= MAX_BUCKETS; i++) {
      const row = rows.get(i);
      const suppressed = !!row && row.participants > 0 && row.participants < MIN_GROUP;
      series.push({
        start: from + i * bucketMs,
        suppressed,
        admitted: suppressed ? null : (row?.admitted ?? 0),
        blocked: suppressed ? null : (row?.blocked ?? 0),
        participants: suppressed ? null : (row?.participants ?? 0),
      });
    }

    const titles = repo.titles();
    const reasons = new Map<BlockedReason, number>();
    const perAutomation = new Map<
      string,
      { triggers: number; admitted: number; reasons: Map<BlockedReason, number> }
    >();
    for (const row of repo.codes(from, to)) {
      let entry = row.automationId ? perAutomation.get(row.automationId) : undefined;
      if (row.automationId && !entry) {
        entry = { triggers: 0, admitted: 0, reasons: new Map() };
        perAutomation.set(row.automationId, entry);
      }
      if (entry) entry.triggers += row.count;
      if (row.code === 'ACCEPTED') {
        if (entry) entry.admitted += row.count;
        continue;
      }
      const reason = reasonOf(row.code);
      reasons.set(reason, (reasons.get(reason) ?? 0) + row.count);
      if (entry) entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + row.count);
    }
    const participantsBy = new Map(
      repo.automationParticipants(from, to).map((row) => [row.automationId, row.participants]),
    );
    const incidentRows = repo.incidents(from, to);
    const incidentsBy = new Map(
      incidentRows.flatMap((r) => (r.automationId ? [[r.automationId, r.count] as const] : [])),
    );
    for (const id of incidentsBy.keys())
      if (!perAutomation.has(id))
        perAutomation.set(id, { triggers: 0, admitted: 0, reasons: new Map() });
    const sortReasons = (map: Map<BlockedReason, number>) =>
      [...map].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
    const automations = [...perAutomation]
      .map(([automationId, entry]) => ({
        automationId,
        title: (titles.get(automationId) ?? 'Removed interaction').slice(0, 200),
        triggers: entry.triggers,
        admitted: entry.admitted,
        blocked: entry.triggers - entry.admitted,
        participants: atLeastGroup(participantsBy.get(automationId) ?? 0),
        incidents: incidentsBy.get(automationId) ?? 0,
        reasons: sortReasons(entry.reasons),
      }))
      .sort((a, b) => b.triggers - a.triggers || a.title.localeCompare(b.title))
      .slice(0, 50);

    const runs = repo.runs(from, to);
    const statusCount = (status: string) => runs.filter((run) => run.status === status).length;
    const terminal = runs.filter((run) => TERMINAL.has(run.status));
    const durations = terminal
      .map((run) => run.durationMs)
      .filter((value): value is number => typeof value === 'number' && value >= 0)
      .sort((a, b) => a - b);
    const compiles: Insights['compiles'] = {
      total: runs.length,
      ready: statusCount('ready'),
      question: statusCount('question'),
      unsupported: statusCount('unsupported'),
      failed: statusCount('failed'),
      cancelled: statusCount('cancelled'),
      successRate: terminal.length ? statusCount('ready') / terminal.length : null,
      medianMs: median(durations),
      p90Ms: percentile(durations, 0.9),
    };

    const finished = repo.sessionsFinished(from, to);
    const sessions: Insights['sessions'] = {
      started: repo.sessionsStarted(from, to),
      finished: finished.reduce((sum, row) => sum + row.count, 0),
      goal: finished.find((row) => row.outcome === 'goal')?.count ?? 0,
      deadline: finished.find((row) => row.outcome === 'deadline')?.count ?? 0,
    };
    const contributors = repo.contributors(from, to);
    const proposals: Insights['proposals'] = {
      suggestions: contributors.suggestions,
      contributors: atLeastGroup(contributors.contributors),
      ballots: repo.ballots(from, to),
      votes: repo.votes(from, to),
      selections: repo.selections(from, to),
    };
    const blockedTotal = totals.attempts - totals.admitted;
    const participation: Insights['participation'] = {
      participants: atLeastGroup(totals.participants),
      attempts: totals.attempts,
      admitted: totals.admitted,
      blocked: blockedTotal,
      activeMinutes: totals.minutes,
      perActiveMinute: totals.minutes
        ? Math.round((totals.admitted / totals.minutes) * 10) / 10
        : 0,
      series,
    };
    const incidents = { total: incidentRows.reduce((sum, row) => sum + row.count, 0) };
    const empty =
      totals.attempts === 0 &&
      runs.length === 0 &&
      sessions.started === 0 &&
      proposals.suggestions === 0 &&
      incidents.total === 0;
    return {
      range: { kind, from, to, bucketMs },
      minimumGroup: MIN_GROUP,
      empty,
      participation,
      blocked: {
        total: blockedTotal,
        reasons: sortReasons(reasons).map((entry) => ({
          ...entry,
          label: REASON_LABEL[entry.reason],
        })),
      },
      automations,
      sessions,
      compiles,
      incidents,
      proposals,
      takeaways: takeaways({ automations, participation, compiles, incidents, proposals }),
    };
  }
  return { summary };
}
export type InsightsService = ReturnType<typeof createInsightsService>;

/** Plain-language, actionable observations; at most six, most actionable first. */
function takeaways(
  input: Pick<Insights, 'automations' | 'participation' | 'compiles' | 'incidents' | 'proposals'>,
): Insights['takeaways'] {
  const out: Insights['takeaways'] = [];
  const blockedMost = input.automations
    .flatMap((automation) => {
      const top = automation.reasons[0];
      return top && top.count >= 5 ? [{ automation, top }] : [];
    })
    .sort((a, b) => b.top.count - a.top.count)
    .slice(0, 3);
  for (const { automation, top } of blockedMost) {
    out.push({
      tone: top.reason === 'duplicate' ? 'info' : 'warn',
      text: `${plural(top.count, 'action')} on ${automation.title} ${top.count === 1 ? 'was' : 'were'} blocked by the ${REASON_LABEL[top.reason].toLowerCase()} — ${ADVICE[top.reason]}.`,
    });
  }
  if (input.incidents.total > 0)
    out.push({
      tone: 'warn',
      text: `${plural(input.incidents.total, 'incident')} stopped an interaction — review Activity before going live again.`,
    });
  const terminal =
    input.compiles.ready +
    input.compiles.failed +
    input.compiles.question +
    input.compiles.unsupported;
  if (terminal >= 3 && (input.compiles.successRate ?? 1) < 0.6)
    out.push({
      tone: 'warn',
      text: `Only ${input.compiles.ready} of ${terminal} generations were ready to review — shorter, more specific descriptions usually compile first time.`,
    });
  if (input.proposals.suggestions > 0 && input.proposals.selections === 0)
    out.push({
      tone: 'info',
      text: `Chat sent ${plural(input.proposals.suggestions, 'suggestion')} — open the proposal inbox to shortlist one or run a ballot.`,
    });
  const { participants, attempts, admitted } = input.participation;
  if (participants !== null && participants >= MIN_GROUP && attempts >= 10) {
    const share = Math.round((admitted / attempts) * 100);
    out.push(
      share >= 70
        ? {
            tone: 'good',
            text: `${participants} people took part and ${share}% of their actions went through.`,
          }
        : {
            tone: 'warn',
            text: `${participants} people took part, but only ${share}% of their actions went through — check the blocked reasons below.`,
          },
    );
  }
  return out.slice(0, 6);
}
