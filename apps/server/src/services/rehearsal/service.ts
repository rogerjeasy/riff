import { randomUUID } from 'node:crypto';
import {
  artifactIdentity,
  createRehearsalPreset,
  manifestSchema,
  minimizeCounterexample,
  rehearsalScenarioHash,
  rehearsalScenarioSchema,
  validateSessionSnapshot,
  sessionDefinitionHash,
  RehearsalError,
  runRehearsal,
  type RehearsalPreset,
  type RehearsalScenario,
} from '@riff/sandbox';
import type { ChannelRepository, VersionRow } from '../../db/repositories/studio.js';
import {
  RehearsalServiceError,
  type Difference,
  type RegressionRecord,
  type RegressionEvidence,
} from './contract.js';
const requireItem = <T>(item: T | undefined): T => {
  if (!item) throw new RehearsalServiceError('NOT_FOUND');
  return item;
};
const artifact = (row: VersionRow) => ({ source: row.source, manifest: row.manifest });
/** Private bounded execution; deliberately has no runtime, outbox, hub or overlay dependency. */
export function createRehearsalService(
  repo: ChannelRepository,
  options: { timeoutMs?: number } = {},
) {
  let active: AbortController | null = null;
  let closed = false;
  let settled: Promise<void> | null = null;
  async function operation<T>(
    signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (closed || signal?.aborted) throw new RehearsalServiceError('ABORTED');
    if (active) throw new RehearsalServiceError('BUSY');
    const controller = new AbortController();
    active = controller;
    let finish = () => {};
    settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? 60_000);
    timer.unref();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const result = await action(combined);
      if (combined.aborted) throw new RehearsalServiceError(timedOut ? 'TIMEOUT' : 'ABORTED');
      return result;
    } catch (error) {
      if (combined.aborted) throw new RehearsalServiceError(timedOut ? 'TIMEOUT' : 'ABORTED');
      if (error instanceof RehearsalError)
        throw new RehearsalServiceError(
          error.code === 'INVALID_CURSOR' || error.code === 'INVALID_SCENARIO'
            ? 'INVALID'
            : error.code,
        );
      throw error;
    } finally {
      clearTimeout(timer);
      if (active === controller) {
        active = null;
        settled = null;
      }
      finish();
    }
  }
  const version = (id: string) => requireItem(repo.version(id));
  const scenario = (id: string) => requireItem(repo.rehearsalScenario(id));
  const run = (id: string) => requireItem(repo.rehearsalRun(id));
  const regression = (id: string) => requireItem(repo.rehearsalRegression(id));
  function recording(input: {
    versionId: string;
    sessionId: string;
    seed: number;
  }): RehearsalScenario {
    // One synchronous SQLite transaction binds the complete journal and exact immutable version.
    return repo.atomic(() => {
      const row = version(input.versionId);
      const entries = repo.sessionJournal(input.sessionId, 122);
      const start = entries[0];
      if (
        !start ||
        start.kind !== 'start' ||
        entries.length > 121 ||
        entries.some((e) => e.versionId !== row.id || e.kind === 'migration') ||
        entries.slice(1).some((e) => e.kind === 'start')
      )
        throw new RehearsalServiceError('UNAVAILABLE');
      const manifest = manifestSchema.parse(row.manifest);
      if (
        !manifest.experience ||
        !start.definition ||
        sessionDefinitionHash(start.definition) !== sessionDefinitionHash(manifest.experience)
      )
        throw new RehearsalServiceError('UNAVAILABLE');
      validateSessionSnapshot(manifest.experience, start.snapshot);
      const identities = new Map<string, string>();
      const events = new Map<string, string>();
      const viewer = (id: string) => {
        let v = identities.get(id);
        if (!v) {
          v = `viewer-${identities.size + 1}`;
          identities.set(id, v);
        }
        return v;
      };
      const eventId = (id: string) => {
        let v = events.get(id);
        if (!v) {
          v = `event-${events.size + 1}`;
          events.set(id, v);
        }
        return v;
      };
      const initialSession = structuredClone(start.snapshot);
      initialSession.id = 'rehearsal';
      initialSession.participants = Object.fromEntries(
        Object.entries(initialSession.participants).map(([id, p]) => [viewer(id), p]),
      );
      const commands = [
        manifest.trigger.command,
        ...manifest.experience.teams.map((t) => t.joinCommand),
      ];
      const steps: RehearsalScenario['steps'] = entries.slice(1).map((entry, i) => {
        const key = `recorded-${i + 1}`;
        if (entry.kind === 'chat') {
          const command = entry.event.text.trim().toLowerCase();
          return {
            kind: 'chat',
            key,
            event: {
              ...entry.event,
              id: eventId(entry.event.id),
              channelId: 'rehearsal',
              viewerId: viewer(entry.event.viewerId),
              text: commands.includes(command) ? command : 'unrelated',
            },
          };
        }
        if (entry.kind === 'advance' || entry.kind === 'pause' || entry.kind === 'resume')
          return { kind: entry.kind, key, at: entry.at };
        throw new RehearsalServiceError('UNAVAILABLE');
      });
      const parsed = rehearsalScenarioSchema.safeParse({
        version: 1,
        seed: input.seed,
        initialAt: start.at,
        initialSession,
        steps,
        expectations: [],
        provenance: {
          kind: 'sanitized-recording',
          originVersionId: row.id,
          originArtifactId: artifactIdentity(artifact(row)),
          originSessionId: input.sessionId,
        },
      });
      if (!parsed.success) throw new RehearsalServiceError('UNAVAILABLE');
      return parsed.data;
    });
  }
  function saveRun(
    input: {
      scenario: RehearsalScenario;
      versionId: string;
      compareVersionId?: string | undefined;
      through?: number | undefined;
      freshStart?: boolean | undefined;
      scenarioId?: string;
      scenarioRevision?: number;
    },
    signal?: AbortSignal,
  ) {
    const primary = version(input.versionId),
      compare = input.compareVersionId ? version(input.compareVersionId) : undefined;
    const changedOrigin = input.freshStart && input.scenario.initialSession !== null;
    const parsed = rehearsalScenarioSchema.safeParse(
      changedOrigin
        ? {
            ...input.scenario,
            initialSession: null,
            provenance: {
              kind: 'synthetic-derivative',
              sourceScenarioHash: rehearsalScenarioHash(input.scenario),
            },
          }
        : input.scenario,
    );
    if (!parsed.success) throw new RehearsalServiceError('INVALID');
    const value = parsed.data;
    return operation(signal, async (signal) => {
      const result = await runRehearsal({
        artifact: artifact(primary),
        scenario: value,
        ...(input.through === undefined ? {} : { through: input.through }),
        signal,
      });
      const comparison = compare
        ? await runRehearsal({
            artifact: artifact(compare),
            scenario: value,
            ...(input.through === undefined ? {} : { through: input.through }),
            signal,
          })
        : null;
      const differences: Difference[] = [];
      if (comparison)
        for (const [i, a] of result.timeline.entries()) {
          const b = comparison.timeline[i];
          if (!b) throw new RehearsalServiceError('UNAVAILABLE');
          const decision =
            JSON.stringify(
              a.decision
                ? {
                    code: a.decision.code,
                    allowance: a.decision.allowance,
                    reason: a.decision.reason,
                  }
                : null,
            ) !==
            JSON.stringify(
              b.decision
                ? {
                    code: b.decision.code,
                    allowance: b.decision.allowance,
                    reason: b.decision.reason,
                  }
                : null,
            );
          const effects =
              JSON.stringify(a.decision?.effects ?? []) !==
              JSON.stringify(b.decision?.effects ?? []),
            state = a.stateDigest !== b.stateDigest;
          if (decision || effects || state)
            differences.push({ through: a.through, key: a.key, decision, effects, state });
        }
      if (signal.aborted) throw new RehearsalServiceError('ABORTED');
      return repo.insertRehearsalRun({
        id: randomUUID(),
        scenarioId: input.scenarioId ?? null,
        scenarioRevision: input.scenarioRevision ?? null,
        versionId: primary.id,
        artifactId: result.artifactId,
        compareVersionId: compare?.id ?? null,
        compareArtifactId: comparison?.artifactId ?? null,
        scenario: value,
        result,
        comparison,
        differences,
        freshStart: input.freshStart ?? false,
        minimization: null,
        createdAt: Date.now(),
      });
    });
  }
  return {
    scenarios: () => repo.rehearsalScenarios(),
    scenario,
    create(input: {
      name: string;
      scenario?: RehearsalScenario;
      recording?: { versionId: string; sessionId: string; seed: number };
    }) {
      const value = input.recording ? recording(input.recording) : input.scenario;
      if (!value || (!input.recording && value.provenance.kind !== 'synthetic'))
        throw new RehearsalServiceError('INVALID');
      return repo.saveRehearsalScenario({
        id: randomUUID(),
        name: input.name,
        revision: 0,
        scenario: rehearsalScenarioSchema.parse(value),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    update(
      id: string,
      input: { name: string; scenario: RehearsalScenario; expectedRevision: number },
    ) {
      const old = scenario(id);
      if (input.scenario.provenance.kind !== 'synthetic')
        throw new RehearsalServiceError('INVALID');
      const value =
        old.scenario.provenance.kind === 'synthetic'
          ? input.scenario
          : {
              ...input.scenario,
              provenance: {
                kind: 'synthetic-derivative' as const,
                sourceScenarioHash: rehearsalScenarioHash(old.scenario),
              },
            };
      const parsed = rehearsalScenarioSchema.safeParse(value);
      if (!parsed.success) throw new RehearsalServiceError('INVALID');
      return repo.saveRehearsalScenario(
        {
          ...old,
          name: input.name,
          scenario: parsed.data,
          revision: old.revision + 1,
          updatedAt: Date.now(),
        },
        input.expectedRevision,
      );
    },
    deleteScenario: (id: string, revision: number) => repo.deleteRehearsalScenario(id, revision),
    preset(input: { versionId: string; preset: RehearsalPreset; seed: number }) {
      return createRehearsalPreset(artifact(version(input.versionId)), input.preset, input.seed);
    },
    recording,
    runs: () => repo.rehearsalRuns(),
    run,
    runScenario(
      id: string,
      input: {
        expectedRevision: number;
        versionId: string;
        compareVersionId?: string | undefined;
        through?: number | undefined;
        freshStart?: boolean | undefined;
      },
      signal?: AbortSignal,
    ) {
      const saved = scenario(id);
      if (saved.revision !== input.expectedRevision) throw new RehearsalServiceError('STALE');
      return saveRun(
        { ...input, scenario: saved.scenario, scenarioId: id, scenarioRevision: saved.revision },
        signal,
      );
    },
    async minimize(
      id: string,
      input: { side: 'primary' | 'compare'; checkId: string },
      signal?: AbortSignal,
    ) {
      const saved = run(id),
        selected = input.side === 'primary' ? saved.result : saved.comparison;
      const versionId = input.side === 'primary' ? saved.versionId : saved.compareVersionId;
      if (
        !selected ||
        !versionId ||
        selected.through !== selected.totalSteps ||
        !selected.checks.some((c) => c.id === input.checkId && c.status === 'failed')
      )
        throw new RehearsalServiceError('INVALID_CHECK');
      const row = version(versionId);
      if (artifactIdentity(artifact(row)) !== selected.artifactId)
        throw new RehearsalServiceError('UNAVAILABLE');
      return operation(signal, async (signal) => {
        const minimized = await minimizeCounterexample({
          artifact: artifact(row),
          scenario: saved.scenario,
          checkId: input.checkId,
          signal,
        });
        if (minimized.originalEvidenceHash !== selected.evidenceHash)
          throw new RehearsalServiceError('UNAVAILABLE');
        if (signal.aborted) throw new RehearsalServiceError('ABORTED');
        return repo.insertRehearsalRun({
          id: randomUUID(),
          scenarioId: saved.scenarioId,
          scenarioRevision: saved.scenarioRevision,
          versionId: row.id,
          artifactId: minimized.run.artifactId,
          compareVersionId: null,
          compareArtifactId: null,
          scenario: minimized.scenario,
          result: minimized.run,
          comparison: null,
          differences: [],
          freshStart: saved.freshStart,
          minimization: minimized,
          createdAt: Date.now(),
        });
      });
    },
    regressions: () => repo.rehearsalRegressions(),
    regression,
    saveRegression(input: { name: string; runId: string; checkId: string }) {
      const saved = run(input.runId),
        minimized = saved.minimization;
      if (
        !minimized ||
        minimized.checkId !== input.checkId ||
        !saved.result.checks.some((c) => c.id === input.checkId && c.status === 'failed')
      )
        throw new RehearsalServiceError('INVALID_CHECK');
      const origin = version(saved.versionId);
      return repo.insertRehearsalRegression({
        id: randomUUID(),
        name: input.name,
        automationId: origin.automationId,
        originVersionId: origin.id,
        originArtifactId: saved.artifactId,
        sourceRunId: saved.id,
        scenario: saved.scenario,
        checkId: input.checkId,
        failure: minimized.failure,
        failedEvidenceHash: saved.result.evidenceHash,
        createdAt: Date.now(),
      });
    },
    deleteRegression: (id: string) => repo.deleteRehearsalRegression(id),
    runRegression(id: string, versionId: string, signal?: AbortSignal) {
      return saveRun({ scenario: regression(id).scenario, versionId }, signal);
    },
    /** Pin records before queueing; deleted/new regressions cannot alter this compile's checks. */
    applicable(baseVersionId: string | null): RegressionRecord[] {
      const ancestors = new Set<string>();
      let next = baseVersionId;
      while (next) {
        if (ancestors.has(next)) throw new RehearsalServiceError('UNAVAILABLE');
        ancestors.add(next);
        next = version(next).parentVersionId;
      }
      return repo.rehearsalRegressions().filter((r) => ancestors.has(r.originVersionId));
    },
    verifyRegressions(
      candidate: { source: string; manifest: unknown },
      pinned: RegressionRecord[],
      signal?: AbortSignal,
    ): Promise<RegressionEvidence[]> {
      if (!pinned.length) return Promise.resolve([]);
      return operation(signal, async (signal) => {
        const results: RegressionEvidence[] = [];
        for (const item of pinned) {
          try {
            const result = await runRehearsal({
              artifact: { source: candidate.source, manifest: candidate.manifest },
              scenario: item.scenario,
              signal,
            });
            results.push({
              regressionId: item.id,
              originVersionId: item.originVersionId,
              originArtifactId: item.originArtifactId,
              scenarioHash: result.scenarioHash,
              result,
              ok: result.status === 'passed',
              failure:
                result.status === 'passed'
                  ? null
                  : result.checks
                      .filter((check) => check.status === 'failed')
                      .map(
                        (check) =>
                          `${check.id}: expected ${check.expected}, actual ${check.actual}.`,
                      )
                      .join(' ')
                      .slice(0, 240),
            });
          } catch (error) {
            if (signal.aborted) throw error;
            results.push({
              regressionId: item.id,
              originVersionId: item.originVersionId,
              originArtifactId: item.originArtifactId,
              scenarioHash: rehearsalScenarioHash(item.scenario),
              result: null,
              ok: false,
              failure: 'Independent rehearsal regression could not replay.',
            });
          }
        }
        return results;
      });
    },
    close() {
      closed = true;
      active?.abort();
      return settled ?? Promise.resolve();
    },
  };
}
export type RehearsalService = ReturnType<typeof createRehearsalService>;
