# Contextual Remix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Track completed tasks and evidence.

**Goal:** Implement F38 portable, licensed recipes and reviewed local remix with a self-hosted public directory.

**Architecture:** Strict immutable packages and channel repositories back export, import, profile, adaptation, installation and moderation services. Existing compiler/verifier and rehearsal provide evidence; existing version review retains activation authority. Browser public and private views use separate route contracts.

**Tech Stack:** Existing TypeScript, Zod, SQLite/Drizzle, Fastify, React, Vitest, Playwright; no dependencies.

**Spec:** `docs/superpowers/specs/2026-11-01-contextual-remix-design.md`

## Global Constraints

- Main branch; preserve all F37/unrelated edits. No commits or pushes in this task.
- Export whitelist only; no private prompts/state/tokens/approval inheritance.
- Exact hashes, pinned editions, explicit publication and local approval.
- Host capability/asset policy always wins over imported metadata and model text.
- Private queries scoped by channel; public only published snapshots.
- Bounds:128KiB package,16KiB source,8 lineage entries,50 imports/reviews/publications,100 reports.

## Review Focus

- Profile or active command changes during async compile/rehearsal invalidate installation.
- Public and hosted-auth routes cannot expose drafts, imported packages or reports.
- Export and descendant re-export retain credits/license without private lineage records.
- Duplicate install and source updates cannot activate or overwrite a local candidate.
- Motion/language/scene adaptations apply to the exact reviewed version without bypassing protected geometry.

### Task 1: Domain, persistence and tests

Files: SDK host recipe types, server `services/recipes/{contract,package,adapt,service}.ts`, `db/repositories/recipes.ts`, schema and generated0013 migration, `test/recipes.test.ts`.
Interfaces: documented service state/export/import/profile/adapt/install/publish/directory/report/moderate/presentation operations; concrete API types in SDK recipe contract.

- [x] Write failing package/privacy/isolation/review tests, run red.
- [x] Implement bounded schema, canonical digests, rights/secret checks and scoped storage.
- [x] Implement compiler/rehearsal evidence, source and profile pinning, conflicts, idempotent installation, opt-in publication and moderation.
- [x] Run focused real sandbox tests green; report exact interfaces to integration owner.

### Task 2: Host integration and presentation

Files: recipe routes, app composition, hosted-session public allowlist, scenes instruction/motion projection, SDK/web scene projection types, relevant server tests.
Interfaces: private `/api/recipes` API with guarded mutations; exact public `/directory/recipes` read/report routes; service presentation callback for current version metadata. Public `/recipes` serves the existing console entry in public-page mode.

- [x] Write failing guards, directory privacy and local activation/presentation tests.
- [x] Wire service/routes/shared compiler queue and shutdown; whitelist exact public paths.
- [x] Connect localized safe instructions and reduced motion through scene projection.
- [x] Run focused host regressions green.

### Task 3: Recipe pages and creator workflow

Files: `apps/web/src/console/recipes/`, public directory component, console entry/composition, schema/API tests and focused e2e.
Interfaces: service contracts from Task1 and routes from Task2. Public view fetches only public recipe projections; private controls use existing request helper.

- [x] Add failing UI/contract tests for import/adapt/diff/install, preview, public metadata and moderation.
- [x] Build accessible library, JSON import/export, profile editor, source/authority diff and rehearsal, install-to-existing-review handoff, publish/report/moderate controls.
- [x] Add public searchable recipe page with playable synthetic sample and download.
- [x] Run focused tests and attempt browser checks; retain actual results.

### Task 4: Independent review and verification

Files: AGENTS/setup/recipe README, CI test selection, this plan.

- [x] Fresh read-only review; regression-test and fix important findings.
- [x] Run full tests, types, lint, format, tooling, build, bundles, smoke and secret scans.
- [x] Document routes, licensing boundaries, limitations and exact verification results.

## Implementation and review record — November 1, 2026

Implemented directly on main, preserving the pending F37 changes. Domain work and
integration followed red/green tests. Independent review found that resolving a
second report could republish a withheld edition and that proxy clients shared one
report quota. Regression tests now cover separate explicit restoration and bounded
client identification through the trusted proxy. Additional regressions cover locale-
independent canonical digests, refreshed capability blockers, changed profile/update
review destinations, host/shared command reservations and truthful stateful rule copy.

The two-instance Fastify workflow runs actual verification and private sandbox
rehearsal, adapts command/audience/window, installs a candidate, then uses ordinary
local approval and scene apply. Localized French instructions and reduced motion
reach the approved scene; descendant exports preserve lineage. Browser coverage is
added in `apps/web/e2e/recipes.spec.ts` for export/publication, public playback, profile
adaptation and candidate review handoff.

### Verification limits

A full unrestricted test run encountered localhost `EPERM` in the two existing
WebSocket suites, including a related uncaught listener error and timeout. An existing
collaboration DOM consent test also failed under heavy concurrent test/build load and
passed in an isolated 16-test UI regression run. The final socket-independent run uses
four workers; its result is recorded below. No unrelated collaboration code was changed.
Playwright could not start its server on `127.0.0.1:8788` (`EPERM`), so browser execution
and visual/accessibility assertions remain unverified in this environment. Tests use
the offline compiler transport and real sandbox, not a live model or Twitch broadcast.

### Final results

- `vitest run --maxWorkers=4 --exclude apps/server/test/twitch-live.test.ts --exclude packages/twitch/test/eventsub-ws.test.ts`: **616 tests passed, 59 files**, including all **22 F38 tests**.
- ESLint and architecture boundaries, strict source/test TypeScript, full Prettier check and `git diff --check`: passed.
- Production build, overlay bundle isolation and Fastify/SQLite smoke: passed.
- Tooling: **15 tests passed**.
- Focused secret scan and redacted Gitleaks over 60 changed/new files: passed, no leaks reported.
- Two WebSocket tests and Playwright: blocked by localhost socket permissions as detailed above; not claimed passing.
- No commits or pushes. All pending F37 and F38 work remains on main for owner review.

## Review and improvement pass — November 1, 2026 (F37 + F38)

Independent server reviews found and fixed, each with a failing regression test first:
F37 — identity memory that silenced cosmetics on busy streams (now oldest-first eviction,
accepted always counted), aborted rehearsals returning 500 (now 409 with a plain reason),
the 50-revision history cap locking drafts (now prunes oldest, never the approved one),
decision logs flooded during bursts (now records changes and merges repeats), machine
clear reasons, unvalidated stored state on boot. F38 — permanent report/library caps,
generated adaptations not checked against the profile, `undefined` canonical digests,
unvalidated manifests, character-based source limit, weak secret filter, unsalted IP
keys, abort/deadline gaps, recipeId spoofing, generic error messages; `service.ts` split
into focused modules; new `POST /api/recipes/remove`.

The console was redesigned: both tools are collapsed cards with status pills; the director
is a guided quiet-chat/burst range editor → private stress test with a batch-by-batch
replay → exact approval → live controls; the recipe library has Remix / Share / Published
tabs with key-level rule diffs, and the public directory has search-as-you-type, deep
links and a two-column detail view. The web parser also rejected stateless SDK 0.4
manifests (`experience: null`), which made every stateless recipe look unsupported.

Verification on this machine: format, lint/boundaries, all typechecks, **640/640 Vitest
tests (61 files)**, 15/15 tooling tests, production build, bundle isolation, smoke and the
focused secret scan passed. **All 9 Playwright specs passed** (first full browser run,
including axe checks on the director, recipe library and public directory). Playwright
projects now run the director/recipes specs after the core studio specs because they
share one server and the studio specs assume an empty library.
