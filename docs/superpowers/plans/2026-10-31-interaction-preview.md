# Interaction Preview Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task by task.

**Goal:** Replay chat through a bounded engine and inspect private effects.
**Architecture:** SDK contracts; sandbox validation and worker; server reference
replay service; React console with private effect stage.
**Tech Stack:** Existing TypeScript, Zod, QuickJS, Fastify, React, Vitest, Playwright.
**Spec:** ../specs/2026-10-31-interaction-preview-design.md

## Global Constraints

64 MB heap, 50 ms interrupt deadline, 2 s worker wall deadline, 25 bridge calls.
No live output in preview. No new dependencies.

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

- [ ] Write and run failing HTTP and browser tests.
- [ ] Implement bounded reference replay endpoint and private effect rendering.
- [ ] Verify repository, browser, accessibility, build and bundle checks.
- [ ] Update implementation status and commit preview, tests and documentation.

## Progress

Owner requested execution following the scope proposal. Use a focused feature branch
in the current checkout and implement inline.
