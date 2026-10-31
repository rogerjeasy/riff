# Live evolution implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task.

**Goal:** Safely evolve active experiences while preserving progress through reviewed, bounded migrations.
**Architecture:** SDK contracts and an effect-free sandbox provide independent preservation checks. Server-owned durable evidence and serialized activation bind migration to current state. Compiler and studio expose the same transition pipeline.
**Tech Stack:** Existing TypeScript, QuickJS, SQLite/Drizzle, Fastify and React; no new dependencies.
**Spec:** `docs/superpowers/specs/2026-10-31-live-evolution-design.md` (approved).

## Global Constraints

- Work directly on main, explicitly authorized; preserve preexisting changes already pushed.
- No new dependencies. SDK stays dependency-free. Generated migration is untrusted.
- No effects, network, random or clock capability in migration execution.
- Preserve current progress or require explicit full reset. Never rewind abuse counters.
- Panic blocks activation; stopped activation stays paused; finished round-end applies immediately.
- Focused conventional commits, no AI attribution, no secret material.

## Review Focus

- In-flight chat and activation: stale revisions must never erase committed points.
- Hostile migration: traps, output limits and malformed state leave live state unchanged.
- Restart and panic: pending changes persist but cannot surprise-reactivate after panic.
- Rollback to fewer resources: explicit reset, never silent resource or score deletion.
- Journal across versions: original rules, migration evidence and live seed must reproduce.

### Task 1: Transition contract and isolated migration engine

Files: SDK types/guide, sandbox transition.ts, migration-worker.ts, index.ts, transition tests.
Produces: exported transition schema, classification, immutable transition identity, async migration runner and independent preservation validator. Choose exact names and report interfaces for later tasks.

- [x] Write failing tests for reference edit (+2 throws and command rename), preservation, incompatible points/teams/resources, hostile code and deterministic execution.
- [x] Implement bounded effect-free worker and independently validate exact preserved fields, resource delta, phase/clock/session identity and revision. No arbitrary score rewriting.
- [x] Run focused tests, lint/type checks; commit focused implementation with tests.

### Task 2: Durable transition lifecycle and journal

Files: server schema/new generated migration/repositories, live/runtime.ts and sessions.ts, automations/studio.ts, routes/studio.ts; sandbox journal.ts and tests.
Consumes: Task 1 exports. Produces: private preview/review, approval, pending/cancel and rollback APIs with typed evidence for studio.

- [x] Write failing tests for current-state revalidation, concurrent chat, paused/round-end boundaries, panic cancellation, storage failure, restart and stale review rejection.
- [x] Persist transition artifacts/evidence/pending status; serialize migration activation with chat/ticks, prepare runtime, CAS state/version/journal atomically and fence old effects.
- [x] Extend journal with verified migrations and original definition; align audit/live random seed and prove random-dependent replay.
- [x] Provide bounded comparison replay with same snapshot/events/seed; no live sinks. Guard routes and tenant scope.
- [x] Run focused integration suites, type checks; commit by coherent lifecycle/replay purpose.

### Task 3: Authoring and studio integration

Files: compiler contract/offline/prompt/intent and tests; server authoring as required; web API/types/review/live and DOM tests.
Consumes: Task 1 transition contract and Task 2 APIs.

- [x] Write failing tests for natural-language reference edit and structured model transition output through the same verification pipeline.
- [x] Implement generation of migration artifacts and independent host checks; preserve backward compatibility for legacy artifacts.
- [x] Add review card with preserved/changed/reset/takes effect; private comparison, boundary choice, pending/cancel and reviewed rollback. Stale UI requests fail visibly.
- [x] Run compiler/server/DOM tests, lint/typecheck; commit compiler and UI slices separately.

### Task 4: Verification and documentation

Files: README, AGENTS, SDK docs, regression tests and implementation files only for confirmed defects.

- [x] Run lint, typecheck, full tests, tooling, build, bundle check, smoke and secret scans.
- [x] Review whole feature against approved acceptance criteria and fix concrete defects with regressions.
- [x] Record environment restrictions separately; update docs with verified behavior and limitations.
- [x] Commit focused documentation; verify actual messages and clean status. Do not push new F32 work unless authorized later.

## Completion evidence

Implemented directly on main after explicit approval. All task reviews and the final
whole-feature review are clean. Reference edit is covered end to end through offline
generation, host migration verification, comparison, chat during review, approval,
new-command participation and journal audit. Structured model output uses the same
host checks; an actual live model call was not exercised for this increment.

Final host run: `./scripts/pnpm test --maxWorkers=1`: 304 passed, two failed because
this environment denies loopback listening (`EPERM` in the EventSub mock transport
and authenticated Twitch-live tests). The associated unhandled error is the same
socket restriction. No full-suite green claim is made. Browser execution also stopped
at server startup with `listen EPERM 127.0.0.1:8788`; DOM/API controls passed.

Lint, all six workspace typechecks, production build, bundle isolation, Fastify/SQLite
smoke, all 15 tooling checks, focused secret scan and Gitleaks history scan passed.
No secrets or attribution trailers were found in the commits. No new dependencies.
The preexisting user changes were pushed before implementation; new F32 commits remain
local, as requested scope was to push the prior changes and then implement.
