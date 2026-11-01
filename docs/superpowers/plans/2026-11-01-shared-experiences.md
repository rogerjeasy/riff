# Shared Experiences Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Preserve other edits. Do not commit or push.

**Goal:** Independently consenting channels play one durable cooperative round with safe local control.
**Architecture:** One coordinator owns a separate existing sandbox engine; authenticated members poll aggregate projections and relay only their own normalized chat. Private local operator routes own consent.
**Tech Stack:** Existing TypeScript, Fastify, SQLite/Drizzle, QuickJS, React/Zod.
**Spec:** ../specs/2026-11-01-shared-experiences-design.md

## Global Constraints

- Directly on main, preserve existing changes, no new runtime dependencies, no commits/push.
- 2–4 roles, unique channels/commands, exact SHA-256 approval; bounded public aggregate fields.
- 15-minute invites, 2-second polling, 10-second leases; independent synchronous local stop.
- Channel-scoped credentials/private snapshots never enter projections.
- Required-member loss and restart pause; no automatic restart of shared gameplay.

## Review Focus

- Old in-flight event or response after leave/panic must never restore local output.
- Shared Chat source metadata cannot elevate receiving-channel roles or duplicate gameplay.
- Lost event responses and process restarts cannot count accepted contributions twice.
- Untrusted coordinator URLs/responses must not leak credentials or create unbounded work.
- Public display must clear on malformed/revoked state and avoid protected screen regions.

## Task 1 — coordinator domain

Files: services/collaboration/{contract,coordinator}.ts, db/repositories/collaboration.ts,
schema.ts and migration 0011; server/test/collaboration.test.ts.
Interfaces: immutable contract `{id,digest,versionId,artifactId,artifact,tests,title,roles}`;
roles `{id,label,channelId,command,required,fields}`. Coordinator factory receives
`{database,repo,now?,blocked?}`. Methods: create(versionId,roles), list(), view(id),
invite(id,roleId), review(token), approve(token,digest), heartbeat(token),
input(token,event), leave(token), control(id,expectedRevision,'start'|'pause'|'resume'),
stop(reason), tick(), close(). Invite returns `{token,contract,roleId,expiresAt}`;
review returns `{contract,roleId}`; heartbeat/input return safe projection/decision.
Tokens are generated per role, stored hashed, independent from revision control.
Owner uses the same invitation/approval path internally. Errors typed with safe messages.

- [x] Write RED tests for approvals, mismatched grants, repeated and echoed input, role isolation,
      deadlines, leave, restart, persistence failure, bounded capacity and stale controls.
- [x] Implement isolated engine and atomic durable state/receipt changes, lease fencing,
      membership-aware reads, safe projection, schema/migration.
- [x] Focused tests and strict server types green.

## Task 2 — local membership and transport

Files: services/collaboration/{member,transport}.ts, routes/collaboration.ts, app.ts,
live/runtime.ts, twitch/connection.ts, twitch normalization and fixture tests.
Independent member runtime pins reviewed contract, verifies candidate locally, seals
credentials, fences local publication/inputs on stop. Private APIs create/invite/review/
approve/control/leave; separate peer review/approve/heartbeat/input/leave uses bearer.
No remote request may call local operator APIs. Validate responses/bounds and use
AbortController deadlines, redirect:error, no credential URLs. Inject fetch for tests.

- [x] RED two-instance inject tests: review is inert, exact local approval, projection,
      duplicate input, stop during pending HTTP, expired lease, hostile remote response.
- [x] Wire EventSub normalized source identities and local panic/status hooks.
- [x] Focused integration tests green, no credentials in private status/public projections.

## Task 3 — console and overlay

Files: web/collaboration/schema.ts, console/collaboration/{panel,api}.ts(x),
overlay/collaboration.ts, overlay/messages.ts/main.ts, console/app.tsx, broker.ts.
Console creates role agreements from cooperative versions, shows invitation/verification/
approval and membership controls. Read-only public rendering honors field grants,
role instructions and paused status. Safe free region comes from existing scene overlay.

- [x] RED DOM tests for required consent, independent roles, safe text and paused output.
- [x] Implement complete creator flow, accessible labels, pending/errors and stale response fencing.
- [x] Add browser journey and compile/bundle checks.

## Task 4 — verification and delivery

- [x] Update AGENTS, ownership README, setup status and main README with actual scope.
- [x] Run lint, types, full host tests, tooling, build, bundles, smoke, secrets and browser when permitted.
- [x] Fresh whole-change review, fix material findings with regressions.
- [x] Leave reviewed working tree for owner; report environment limitations accurately.

## Execution record

Task 1: coordinator domain implemented with 15 passing invariant tests, including
required-member expiry during guest execution and write-failure recovery fencing.
Task 2: member/peer routes and authenticated chat integration implemented. Separate
HTTP instances/databases prove private review, exact consent, aggregate projection,
dedupe, safe departure, sealed credentials and no private participant leakage.
Ruling: “one active” means one running shared session; paused/waiting drafts remain
bounded at 20 so a creator can prepare a replacement without deleting history.
Ruling: existing local command conflicts block membership; a later conflicting local
activation stops the shared membership at input/poll rather than silently mixing games.
Task 3: complete browser workflow, eight passing DOM/boundary tests, and a mocked
protocol Playwright/axe journey added. Browser execution remains blocked by localhost
EPERM; this is recorded rather than reported as passed.
Final review: three Important findings, no Critical or deferred Minor findings.
Final fixes: pinned guidance enforced, incident quarantine recorded before persistence,
and local polling read failures fence publication. All three regression tests observed
RED then GREEN. Full verification evidence is recorded in docs/setup-status.md.
Task 4: implementation and review complete; no commits/push performed.
