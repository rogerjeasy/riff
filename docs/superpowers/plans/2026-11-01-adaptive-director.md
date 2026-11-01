# Adaptive Director Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver F37 approved, explainable presentation adaptation with private stress evidence and creator control.

**Architecture:** Pure host policy receives already accepted decisions. A channel-scoped service persists review and controls, drives a bounded queue, and emits through the existing overlay only after validity checks. Rehearsal reuses the same policy with isolated sandbox outputs.

**Tech Stack:** Existing TypeScript, Zod, Drizzle/SQLite, Fastify, React, Vitest, Playwright; no dependencies.

**Spec:** `docs/superpowers/specs/2026-11-01-adaptive-director-design.md`

## Global Constraints

- Work directly on main; preserve unrelated edits. Leave changes for user review; no commits/push in this task.
- Host presentation only; all competitive changes remain F32. Preview has no live sinks.
- 120 pending effects, 5-second freshness, 2000 identity entries, 50 envelope revisions.
- Scope all persistent records by channel. Panic fences memory before persistence.
- Do not introduce prohibited artifact names or attribution.

## Review Focus

- In-flight replay plus changed draft must fail CAS, never approve stale evidence.
- Delayed queue emission after pause/rollback/round reset must not leak stale effects.
- Failed persistence during stop must leave output stopped in memory.
- First-time priority must reset by round and never change gameplay eligibility.
- Invalid browser frames must not bypass intensity or protected scene constraints.

### Task 1: Policy and contracts

Files: `packages/sdk/src/director.ts`, SDK exports, `apps/server/src/services/director/{contract,policy}.ts`, `apps/server/test/director-policy.test.ts`.
Interfaces: `DirectorEnvelope`, `DirectorSettings`, `DirectorFrame`, `DirectorSnapshot`; `createDirectorPolicy(envelope)` exposes enqueue/tick/configure/clear/snapshot. No network/database dependency.

- [x] Write failing tests for bounds, surge, lock/override, round priority, dedupe, expiration and conservation of offered effects.
- [x] Run focused Vitest red; implement deterministic policy; rerun green.

### Task 2: Durable review and live integration

Files: new director repository/table/generated migration, director service/rehearsal, routes; app and overlay broker integration; `apps/server/test/director.test.ts`.
Interfaces: GET `/api/director`; POST `/api/director/draft` (expectedRevision,envelope), `/rehearse` (expectedRevision,versionId), `/approve` (expectedRevision,digest,evidenceHash), `/control` (expectedRevision,action,settings?), `/stop` (empty). Responses `{state}`. Service accepts committed effects and emits host frames via callback; no generated code changes.

- [x] Write failing API/replay tests including actual session scores, stale revisions, isolation, restart, stop write failure and late invalidation.
- [x] Implement scoped persistence and generate migration with drizzle-kit.
- [x] Wire broker, lifecycle, pause/panic fences; run focused policy/API regressions.

### Task 3: Console and overlay

Files: `apps/web/src/console/director/`, console composition, web director types/schema, overlay intensity rendering, `apps/web/e2e/director.spec.ts` and web contract tests.
Interfaces: same route contract as Task 2; effect frames optionally include intensity 25–100. Console-only APIs never enter overlay bundle.

- [x] Add browser tests for private surge review, exact approval, controls and range rejection.
- [x] Build accessible draft/review/control panel with bounded polling, error states, private visual replay and evidence counters.
- [x] Propagate validated intensity to shared projectile renderer while preserving reduced motion and scene clipping.
- [x] Run web tests and attempt focused Playwright.

### Task 4: Review, documentation and verification

Files: AGENTS.md, setup/status docs, director README, CI relevant test inclusion.

- [x] Document actual routes, table, behavior and limits.
- [x] Run fresh independent read-only review; regression-test important findings and fix.
- [x] Run lint, formatting, typechecks, tests, tooling, secret scan, build, bundle isolation and smoke.
- [x] Record exact passed/blocked checks and leave focused uncommitted changes for review.

## Verification record

Implemented on main, left uncommitted for review. Final director-specific suites:
24 tests passed (12 host integration, 7 pure policy, 5 browser-contract/UI tests).
The full Vitest run passed 593 tests and had two environment-blocked failures:
`packages/twitch/test/eventsub-ws.test.ts` and
`apps/server/test/twitch-live.test.ts` cannot bind local sockets (`listen EPERM`);
the latter also reports the associated unhandled listen error. This is not a
fully green full-suite run. The focused Playwright attempt was blocked before
browser startup by `listen EPERM 127.0.0.1:8788`.

Lint/boundaries, formatting, all six workspaces' strict source/test typechecks,
production build, overlay bundle isolation and smoke passed. All 15 tooling tests
passed. Focused secret checks and Gitleaks over changed/new source files passed.
No claim of a live Twitch or rendered browser demonstration is made.

The independent review found a version/round queue invalidation gap. Regressions
for swap, rollback and reset failed first, then passed after explicit invalidation.
Durable interruption-budget claims also prevent repeated approval or restart from
refilling the rolling allowance; repository and live restart tests cover this.

Implementation decisions: host-only presentation parameters use the existing scene
canvas for protected areas; competitive rules remain in F32. A frontend worker
owned only web files while the primary implementation covered host integration.
Concurrent user authentication/deployment edits were preserved. User-directed
implementation on main takes precedence over worktree and plan-approval defaults.
