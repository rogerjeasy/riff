# Interactive Rehearsal Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task-by-task.

**Goal:** Deliver F34 private timeline rehearsal, comparison and retained counterexamples.
**Architecture:** Pure bounded sandbox replay, scoped persistence/host verification,
and a creator timeline UI consuming strict private APIs. Prefix replay reconstructs
all private state; nothing receives a live sink.
**Tech Stack:** Existing TypeScript, QuickJS, Zod, Drizzle/SQLite, Fastify, React, Vitest.
**Spec:** docs/superpowers/specs/2026-11-01-interactive-rehearsal-design.md

## Global Constraints

- Direct implementation on main authorized; no extra approval checkpoint, dependency or network adapter.
- No SDK guest capability changes. No live state, credentials or sinks reach rehearsal.
- Exact version/seed/scenario evidence, channel-scoped persistence and revision fences.
  -120 steps/20 expectations/128KiB scenario;24 minimization replays/2400 dispatched steps.
- One expensive job/channel,60s timeout;50 scenarios/100 runs/50 regressions per channel,10 regressions/automation.
- Preserve F32/F33 approval, ancestry and existing private proof functionality.
- Focused commits with tests, no attribution, no push; root owns final full checks/docs.

## Review Focus

- Backward seek then forward replay retains randomness, dedupe and allowance parity.
- Late requests after version/revision switches cannot supply current evidence or overwrite inputs.
- Counterexample deletion cannot switch failure identity; budgets/cancellation must release workers.
- Sanitized recordings cannot leak names/IDs/chat or claim unsupported multi-version fidelity.
- Generated repair cannot weaken saved expectations or bypass removed proposal ancestry.

### Task 1: Bounded deterministic rehearsal engine

**Files:** create packages/sandbox/src/rehearsal.ts (split contract/presets/minimizer if useful),
modify packages/sandbox/src/index.ts; add packages/sandbox/test/rehearsal.test.ts.
**Produces:** exported rehearsalScenarioSchema and RehearsalScenario; runRehearsal({artifact,
scenario,through?,signal?}); minimizeCounterexample({artifact,scenario,checkId,signal?});
createRehearsalPreset(artifact,preset,seed). Exact result types reported for Task2.
Artifact uses existing source/manifest shape; through counts applied steps. Scenario
and result implement all exact spec bounds, provenance and supported checks.

- [x] Write failing tests for prefix/full parity including randomized effects, duplicates,
      rate windows, stateful controls/deadline, initial snapshot, zero/end cursor and
      isolation from injected original objects; use real engine and literal checks.
- [x] Implement strict bounded scenario contracts, private execution and compact frames/
      cursor, automatic and explicit checks, stable scenario/evidence hashes and presets.
- [x] Write/observe failing minimization tests for a noise+three throws+fourth expected
      accepted counterexample; retain failure identity and required duplicate prerequisites;
      test abort and replay/step budgets. Implement bounded reduction with final validation.
- [x] Run focused sandbox tests, sandbox types/scoped lint; commit engine/tests and
      report exact exported types/functions, limitations and verification.

### Task 2: Durable private authoring and regression verification

**Files:** server schema/generated0009 migration, db/repositories/rehearsals.ts,
services/rehearsal service/modules, routes/rehearsals.ts, app wiring;
authoring service/evidence views; compiler contract/workspace+recorded fixture;
server and compiler focused tests. No web code.
**Consumes:** Task1 report exports; existing repo version/sessionJournal and authoring
start/verify path. **Produces:** exact private HTTP shapes for Task3 in task report.

- [x] Write failing route/service tests with real migrated SQLite for lifecycle/revision,
      exact artifact pinning, tenant isolation, budgets, restart, seek/compare and cancellation.
- [x] Implement durable bounded scenarios/runs/regressions and guarded private API.
      Resolve artifacts server-side only; recording import sanitizes a bounded complete
      single-version journal, rejects unsupported provenance and never writes live tables.
- [x] Write/observe failures for minimization retention, regression rerun, no live overlay/
      admission/session mutation, and sanitized persisted/API/compiler content.
- [x] Connect explicit repair and applicable ancestor regressions to existing authoring
      pipeline; separate bounded compiler evidence data; pin checked set/results, keep
      one automatic repair and F33 lineage checks. Add recorded fixture/prompt tests.
- [x] Verify wrong repairs fail independent checks, passing repair produces only a
      candidate, retained regressions survive restart and removed lineage blocks repair.
      Run focused tests/types/lint, focused commits, exact interface report.

### Task 3: Interactive creator rehearsal studio

**Files:** web rehearsal modules, lib API/types, app handoff, styles, DOM/API tests;
local responsibility READMEs. No new dependencies/server trust decisions.
**Consumes:** Task2 exact contracts, Task1 result concepts; existing quick stage and
run/evidence/review flow. **Produces:** complete usable F34 journey.

- [x] Write failing DOM/API tests for save/load/presets, injection, play/step/seek,
      reset, state/decision/expectation inspector, comparison and failed check reduction.
- [x] Implement accessible responsive advanced rehearsal studio, clear private/provenance
      labels, seed/origin controls, timeline and synchronized two-version comparison.
      Keep quick proof and local effect isolation; seeking clears previous effects.
- [x] Add immutable regression library/rerun/delete and reviewed explicit repair handoff;
      test no automatic generation/activation and immediate returned run tracking.
- [x] Test abort/late responses, stale revisions, version switches, limits and unavailable
      recording/comparison. Run full web tests, webtypes/scoped lint, focused commits/report.

### Task 4: Whole-feature verification and documentation

**Files:** README, AGENTS, rehearsal ownership docs, spec/plan completion evidence.

- [ ] Full tests one worker, lint/types/build/bundles/tooling/smoke and secret scans.
- [ ] Final independent feature review; one complete fix wave and scoped re-review.
- [ ] Attempt browser checks where permitted; distinguish environment failures from passes.
- [ ] Document demo, supported controls/recordings, host checks, bounds and verification;
      commit docs, inspect actual messages, leave clean main without pushing.
