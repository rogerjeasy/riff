# Interaction Preview Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task by task.

**Goal:** Replay chat through a bounded engine and inspect private effects.
**Architecture:** SDK contracts; sandbox validation and worker; server reference
replay service; React console with private effect stage.
**Tech Stack:** Existing TypeScript, Zod, QuickJS, Fastify, React, Vitest, Playwright.
**Spec:** ../specs/2026-10-31-interaction-preview-design.md

## Global Constraints

64 MB heap, 50 ms interrupt deadline, 2 s worker wall deadline, 25 bridge calls.
No live output in preview. No new dependency versions; declare the existing pinned
TypeScript in the sandbox for AST instrumentation of detached asynchronous work.

## Review Focus

Rolling expiration and concurrent input; caught faults after emitting; promise storms;
changed duplicate payloads; bounded preview input and concurrency.

### Task 1: Contract and engine

Files: packages/sdk/src/index.ts, packages/sdk/SDK.md,
packages/sandbox/src/{contract,engine,guest-worker,index}.ts,
packages/sandbox/test/engine.test.ts.
Produces: createPreviewEngine(artifact, seed), engine.dispatch(event), engine.stop().

- [x] Write and run failing acceptance tests for quotas, deduplication, permissions,
      replay, hostile execution and stop.
- [x] Implement validation, atomic host admission and supervised guest execution.
- [x] Verify and commit engine, tests and documentation.

### Task 2: Private preview

Files: apps/server/src/services/rehearsal/preview.ts,
apps/server/src/routes/preview.ts, apps/web/src/console/rehearsal/preview.tsx,
apps/server/test/preview.test.ts, apps/web/e2e/preview.spec.ts.
Consumes: Task 1 engine. Produces ordered decision/effect evidence over HTTP.

- [x] Write and run failing HTTP tests; add the browser scenario (socket binding blocked before browser assertions).
- [x] Implement bounded reference replay endpoint and private effect rendering.
- [x] Verify repository, build, formatting and bundle checks. Browser/accessibility execution remains blocked by EPERM.
- [x] Update implementation status and commit preview, tests and documentation.

## Progress

Owner requested execution following the scope proposal. Use a focused feature branch
in the current checkout and implement inline.

Execution evidence: lint, type checks, 55 host/runtime/DOM tests, 15 tooling tests,
production build, bundle isolation, formatting and Fastify/SQLite smoke checks pass.
Browser execution attempted; loopback server binding rejected with EPERM.

Review fixes: deduplicate before clock mutation; instrument detached async failures
and observe call results; cancel/release the service on disconnect; dispose QuickJS
handles correctly and publish only after cleanup. CPU budget uses worker CPU usage,
with an independent parent wall deadline. Cold worker startup is separately bounded
to 10 seconds; it does not consume the 2-second handler deadline. Runtime authoring and live lifecycle remain
subsequent increments, as scoped in the design.
