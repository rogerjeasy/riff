# Production and Participation Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Record evidence and review.

**Goal:** Deliver F39 trusted production connections and F40 accessible current participation guidance.
**Architecture:** Channel-scoped persisted host services, existing approval controls and safe scene rendering; strict private APIs and public allowlisted guidance.
**Tech Stack:** Existing TypeScript, Fastify, Zod, SQLite/Drizzle, ws, obs-websocket-js, React.
**Spec:** `docs/superpowers/specs/2026-11-01-production-participation-design.md`

## Global Constraints

- Main branch; no commits, no new dependencies, no user work overwritten.
- Secrets AES-GCM only, no guest/raw transport access, no fabricated Twitch input.
- Exact grants and review hashes; no implicit approval or external side effects in preview.
- Panic and disconnect fence pending work; bounded work and receipts; no ambiguous retries.
- Preserve existing approved eligibility/competitive semantics; F40 preferences are presentation only.

## Review Focus

- Stale setup approval, changed OBS settings, revoked grants during awaited calls.
- Duplicate/looped events after reconnect or restart cannot replay production mutations.
- Public guidance and test URLs never expose secrets or private identity/state.
- Help must not weaken privileged !riff panic roles or extend beyond bounded quotas.
- Motion/language settings survive edits and work with recipe presentation and protected scenes.

### Task 1: Trusted production backend

Owned by production worker: `apps/server/src/adapters/{obs,streamer-bot}/`,
`services/production/`, `db/repositories/production.ts`, `routes/production.ts`,
`packages/sdk/src/production.ts`, `apps/server/test/production*.test.ts`.
Root owns schema/migration and app integration. Assume exported table `productionState`
with channelId PK and value JSON Record<string,unknown>. All private access channel scoped.

Interface: `createProductionService({database,repo,secret,overlayUrl:()=>string,blocked:()=>boolean,control:(versionId:string,action:'start'|'pause')=>unknown,...transport injection})`.
Expose `view()`, `stop()`, `close()`, `observe()` plus typed actions consumed by own
`registerProductionRoutes(app,service)`. Send root concrete schema/routes early for UI.
`control` must be called only after verifying exact local version is approved, healthy
and current active; never approve/activate a new version. `observe` is called on studio
updates and timer; it checks finished sessions and emits mapped allowed bot actions.

- [x] Write failing scoped setup/credentials/panic/loop/import tests and run red.
- [x] Implement actual OBS and authenticated Streamer.bot adapters using verified official protocols; pure fake injectable transport for tests.
- [x] Implement bounded durable service, grants/setup review, imports and routes, docs.
- [x] Run focused tests/types/lint; return exact integration contract and report.

### Task 2: Participation service and shared host integration

Root owns schema (productionState and participationState JSON tables), generated0014
migration, SDK participation types, `services/participation/`, `routes/participation.ts`,
app/runtime/scenes composition and `test/participation.test.ts`.

- [x] Red tests: private settings CAS, public whitelist, actual rule translations, help quotas/deduplication and persistence.
- [x] Implement current guidance from active approved versions/sessions, settings and bounded help admission.
- [x] Add safe callback to runtime after panic check, compose scene instruction/motion policy with recipes, wire production stop/control/observe.
- [x] Green tests including hosted auth separation and existing scene/runtime regressions.

### Task 3: Creator production controls and viewer surfaces

Root owns `apps/web/src/console/production/`, `console/participation/`, `participation/`,
console entry/composition, dock candidate review and overlay test frame; UI contracts/tests/e2e.

- [x] Red tests: connection/setup needs review, no secrets in public page, saved accessibility preferences, dock exact candidate review.
- [x] Implement collapsed production card, OBS grants/setup/test/rollback, bot mappings/import diff and explicit grants; integrate service routes.
- [x] Add participation settings and public companion page; enhance dock with evidence and exact existing approval API.
- [x] Green DOM tests, browser/accessibility test attempt, record external limitations.

### Task 4: Review and verification

- [x] Independent focused review of production backend, then whole integration; regression fixes.
- [x] Full relevant tests, lint/types/format, build/bundles/smoke/tooling/secrets.
- [x] Update AGENTS, setup status and service READMEs with actual supported protocols and limitations.

## Review and improvement pass — November 1, 2026

Independent server reviews found, and regression tests now cover:

- F39: every authenticated OBS connection failed (obs-websocket-js strips `authentication`
  from the returned Hello; the unit mock hid it) — fixed via the library's Hello event and
  proven with real in-process msgpack/JSON protocol servers for OBS and Streamer.bot;
  reconnect stranding applied sources (rollback/re-review now survive reconnect); merely
  reviewing/importing mappings disabled live ones; approval left a stale second review;
  the import "diff" listed only incoming items; bot events dropped silently while OBS
  was busy; unused passwords stored forever (no longer stored); one oversized discovery
  entry failed the whole connection. `service.ts` split into focused modules.
- F40: rule copy misstated limits/eligibility in all languages (now whole-sentence
  templates per language with tests per manifest shape); plain `!riff help` was invisible
  (now a 15 s on-stream highlight); viewers could override an explicit channel language;
  cache-busting query keys were rejected; public guidance had no cache or rate limit;
  recipe digests churned on new presentation keys; display names containing " · " were cut.

Console redesign: production connector cards, a guided OBS review → test frame → live
stepper, mapping table with reviewed diffs and discard; participation settings with
switches and a live "what viewers see" preview; a redesigned public `/participate` page
(copyable command chips, live countdown, goal meter, score bars, true black/white/yellow
high contrast, localized titles); the dock candidate review fits OBS dock width.

Verification on this machine: format, lint/boundaries, typechecks, **743/743 Vitest tests
(69 files)**, 15/15 tooling, build, bundle isolation, smoke, focused secret scan and **all
11 Playwright specs** passed. A manual walkthrough drove the real adapters against
protocol-accurate fake OBS (msgpack) and Streamer.bot servers: connect both, OBS review →
test frame → live, and mapping approval. Real OBS/Streamer.bot installs were not tested.
