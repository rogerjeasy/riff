# Audience co-creation implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development task-by-task.

**Goal:** Complete moderated audience-to-approved-interaction workflow using F32.
**Architecture:** Trusted proposal domain with durable scoped records; normalized chat
ingress and guarded creator routes; provenance fences in authoring/activation; safe
audience projection and creator inbox. No network adapter changes.
**Tech Stack:** Existing TypeScript, Drizzle/SQLite, Fastify, React and Vitest.
**Spec:** `docs/superpowers/specs/2026-11-01-audience-co-creation-design.md`.

## Global Constraints

- Work on main explicitly authorized; no new dependencies or remote services.
- Existing local console is creator authority. Moderators require explicit Riff grant.
- Only creator actions generate/activate; votes and raw chat never grant authority.
- All proposal records/queries channel scoped; no private/unmoderated text in overlays.
- Preserve F32 state/budget/panic invariants and SDK package boundaries.
- Focused conventional commits, explicit paths, no attribution or secrets. Do not push.

## Review Focus

- Hide while generation/approval is in flight: provenance rechecks prevent stale activation.
- Redelivery and restarts: limits, dedupe and one vote/account remain durable.
- Different ballot IDs/tenants: delayed votes cannot target a new or foreign ballot.
- Privacy: duplicates, history, credit revocation, panic and reconnect cannot leak text.
- Creator UI stale selection/double click cannot spend quota or apply unintended version.

### Task 1: Durable proposal domain and command policy

Files: server DB schema/new migration/repository, services/proposals domain, focused tests.
Produces: channel-scoped proposal service methods for submit/moderate/grants/credit,
ballots/votes/select/revoke, snapshots/public projection and trusted command parsing.
Report exact interfaces for later tasks. Own only this domain, not app/runtime/routes.

- [x] Write failing durable tests for full lifecycle, per-account/channel limits,
      duplicates/provenance, explicit grants, one vote, expiry, hidden/stale selection,
      restart and channel isolation, with injected clock and real SQLite.
- [x] Implement bounded schema/transactions and reserved command parser, admission
      receipts and immutable selection records per spec; no compilation dependencies.
- [x] Ensure public projection includes only moderated eligible content and consented
      names; no private data in errors. Test hide/credit removal.
- [x] Run focused tests, lint/typecheck; commit coherent domain slice(s).

### Task 2: Chat, creator API, authoring lineage and activation fences

Files: app wiring, runtime ingress, routes/proposals, authoring, version/transition
activation repositories, overlay broker and focused integration tests/migrations.
Consumes Task1 interfaces. Produces typed endpoints, studio summary and safe overlay
community message for Task3. No web implementation yet.

- [x] Write failing tests driving normalized chat through proposal service and proving
      viewer/mod actions never call compiler; maintain panic precedence and swallow only
      reserved commands. Guard tenant and local mutation boundaries.
- [x] Connect creator moderation/ballot/select/generate endpoints; one run per selection,
      edited bounded brief and base version; store lineage durably across derived versions.
- [x] Enforce revoked lineage before compile/store and inside ordinary/F32 activation
      CAS, invalidate pending work on hide. Test races with controllable compiler transport.
- [x] Publish moderated projection and outcomes through broker; clear on panic and
      never repopulate while stopped. Check cache/rotation/reconnect and attribution.
- [x] Test end-to-end proposal→selection→generation→F32 preview/approval and retained
      progress, hide-before-activation, duplicates/restart. Commit integration slices.

### Task 3: Creator inbox and audience presentation

Files: web API/types, console proposals panel/app wiring, overlay safe DOM presentation,
styles and DOM/API tests; update ownership READMEs as useful.
Consumes Task2 exact API/projection. No new library or server trust decisions.

- [x] Write failing UI tests for moderation, granted moderators, duplicate groups,
      ballot selection/results, editable selected brief, deliberate generate and candidate
      review, stale requests and quota errors.
- [x] Implement accessible responsive inbox and existing authoring/review handoff;
      avoid any direct proposal activation shortcut. Show command/privacy guidance.
- [x] Render bounded moderated ballot/outcome projection on overlay with safe text,
      liveness/panic clearing and credit opt-in; test hidden/private fields never render.
- [x] Run focused DOM/API tests, lint/types; commit UI slice(s).

### Task 4: Whole-feature review, verification and documentation

Files: README, AGENTS, design/plan completion evidence; fixes only for concrete findings.

- [ ] Run full tests with one worker, lint/types/build/bundles/smoke/tooling/secrets.
- [ ] Review all acceptance criteria and race/privacy boundaries; fix regressions.
- [ ] Attempt browser verification where available; report socket/environment blocks
      separately from passing checks and do not claim live Twitch/model testing.
- [ ] Document commands, grants, limits and complete demo flow; commit focused docs.
