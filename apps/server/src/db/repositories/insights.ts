import type { DatabaseConnection } from '../client.js';

/**
 * Channel-scoped aggregate reads for F30 insights. Every statement binds `channel_id`
 * and numeric bounds as parameters; nothing user-supplied is ever interpolated. Only
 * counts leave this module — never viewer names or account identifiers.
 */
export function insightsRepository(connection: DatabaseConnection, channelId: string) {
  const { client } = connection;
  const decisionTimes = client.prepare<[string, number, number], { at: number }>(
    `SELECT at FROM activity
     WHERE channel_id = ? AND kind = 'decision' AND code IS NOT NULL AND code != 'UNRELATED'
       AND at >= ? AND at <= ?
     ORDER BY at DESC LIMIT 50000`,
  );
  const latestDecision = client.prepare<[string], { at: number | null }>(
    `SELECT MAX(at) AS at FROM activity
     WHERE channel_id = ? AND kind = 'decision' AND code IS NOT NULL AND code != 'UNRELATED'`,
  );
  const totals = client.prepare<
    [string, number, number],
    { attempts: number; admitted: number; participants: number; minutes: number }
  >(
    `SELECT COUNT(*) AS attempts,
            COALESCE(SUM(code = 'ACCEPTED'), 0) AS admitted,
            COUNT(DISTINCT viewer) AS participants,
            COUNT(DISTINCT at / 60000) AS minutes
     FROM activity
     WHERE channel_id = ? AND kind = 'decision' AND code IS NOT NULL AND code != 'UNRELATED'
       AND at >= ? AND at < ?`,
  );
  const buckets = client.prepare<
    [number, number, string, number, number],
    { bucket: number; admitted: number; blocked: number; participants: number }
  >(
    `SELECT CAST((at - ?) / ? AS INTEGER) AS bucket,
            SUM(code = 'ACCEPTED') AS admitted,
            SUM(code != 'ACCEPTED') AS blocked,
            COUNT(DISTINCT viewer) AS participants
     FROM activity
     WHERE channel_id = ? AND kind = 'decision' AND code IS NOT NULL AND code != 'UNRELATED'
       AND at >= ? AND at < ?
     GROUP BY bucket ORDER BY bucket`,
  );
  const codes = client.prepare<
    [string, number, number],
    { automationId: string | null; code: string; count: number }
  >(
    `SELECT automation_id AS automationId, code, COUNT(*) AS count
     FROM activity
     WHERE channel_id = ? AND kind = 'decision' AND code IS NOT NULL AND code != 'UNRELATED'
       AND at >= ? AND at < ?
     GROUP BY automation_id, code`,
  );
  const automationParticipants = client.prepare<
    [string, number, number],
    { automationId: string; participants: number }
  >(
    `SELECT automation_id AS automationId, COUNT(DISTINCT viewer) AS participants
     FROM activity
     WHERE channel_id = ? AND kind = 'decision' AND code IS NOT NULL AND code != 'UNRELATED'
       AND automation_id IS NOT NULL AND at >= ? AND at < ?
     GROUP BY automation_id`,
  );
  const incidents = client.prepare<
    [string, number, number],
    { automationId: string | null; count: number }
  >(
    `SELECT automation_id AS automationId, COUNT(*) AS count FROM activity
     WHERE channel_id = ? AND kind = 'incident' AND at >= ? AND at < ?
     GROUP BY automation_id`,
  );
  const titles = client.prepare<[string], { id: string; title: string }>(
    `SELECT id, title FROM automations WHERE channel_id = ?`,
  );
  const runs = client.prepare<
    [string, number, number],
    { status: string; durationMs: number | null }
  >(
    `SELECT status, duration_ms AS durationMs FROM compile_runs
     WHERE channel_id = ? AND created_at >= ? AND created_at < ?
     ORDER BY created_at DESC LIMIT 5000`,
  );
  const started = client.prepare<[string, number, number], { count: number }>(
    `SELECT COUNT(DISTINCT session_id) AS count FROM session_journal
     WHERE channel_id = ? AND kind = 'start' AND at >= ? AND at < ?`,
  );
  const finished = client.prepare<
    [string, number, number],
    { outcome: string | null; count: number }
  >(
    `SELECT json_extract(snapshot, '$.outcome') AS outcome, COUNT(DISTINCT session_id) AS count
     FROM session_journal
     WHERE channel_id = ? AND at >= ? AND at < ?
       AND json_extract(snapshot, '$.phase') = 'finished'
     GROUP BY outcome`,
  );
  const contributors = client.prepare<
    [string, number, number],
    { suggestions: number; contributors: number }
  >(
    `SELECT COUNT(*) AS suggestions, COUNT(DISTINCT account_id) AS contributors
     FROM proposal_contributors WHERE channel_id = ? AND created_at >= ? AND created_at < ?`,
  );
  const ballots = client.prepare<[string, number, number], { count: number }>(
    `SELECT COUNT(*) AS count FROM proposal_ballots
     WHERE channel_id = ? AND created_at >= ? AND created_at < ?`,
  );
  const votes = client.prepare<[string, number, number], { count: number }>(
    `SELECT COUNT(*) AS count FROM proposal_votes WHERE channel_id = ? AND at >= ? AND at < ?`,
  );
  const selections = client.prepare<[string, number, number], { count: number }>(
    `SELECT COUNT(*) AS count FROM proposal_selections
     WHERE channel_id = ? AND created_at >= ? AND created_at < ?`,
  );
  return {
    latestDecisionAt: () => latestDecision.get(channelId)?.at ?? null,
    /** Decision timestamps, newest first, used only to find the last stream's start. */
    decisionTimes: (from: number, to: number) =>
      decisionTimes.all(channelId, from, to).map((row) => row.at),
    totals: (from: number, to: number) =>
      totals.get(channelId, from, to) ?? { attempts: 0, admitted: 0, participants: 0, minutes: 0 },
    buckets: (from: number, to: number, bucketMs: number) =>
      buckets.all(from, bucketMs, channelId, from, to),
    codes: (from: number, to: number) => codes.all(channelId, from, to),
    automationParticipants: (from: number, to: number) =>
      automationParticipants.all(channelId, from, to),
    incidents: (from: number, to: number) => incidents.all(channelId, from, to),
    titles: () => new Map(titles.all(channelId).map((row) => [row.id, row.title])),
    runs: (from: number, to: number) => runs.all(channelId, from, to),
    sessionsStarted: (from: number, to: number) => started.get(channelId, from, to)?.count ?? 0,
    sessionsFinished: (from: number, to: number) => finished.all(channelId, from, to),
    contributors: (from: number, to: number) =>
      contributors.get(channelId, from, to) ?? { suggestions: 0, contributors: 0 },
    ballots: (from: number, to: number) => ballots.get(channelId, from, to)?.count ?? 0,
    votes: (from: number, to: number) => votes.get(channelId, from, to)?.count ?? 0,
    selections: (from: number, to: number) => selections.get(channelId, from, to)?.count ?? 0,
  };
}
export type InsightsRepository = ReturnType<typeof insightsRepository>;
