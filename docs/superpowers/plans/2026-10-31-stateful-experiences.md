# Stateful Experiences Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development with isolated
> ownership for SDK/sandbox, compiler and web; coordinator owns server integration.

**Goal:** Generate, verify, rehearse and play durable competitive/cooperative sessions.
**Architecture:** Canonical bounded definitions and pure host reducers; fresh QuickJS
invocations for effects; transactional SQLite state/journal/outbox; validated HUD.
**Tech Stack:** Existing TypeScript, Zod, QuickJS, SQLite/Drizzle, React, Vitest.
**Spec:** ../specs/2026-10-31-stateful-experiences-design.md

## Constraints and review focus

Preserve 0.3.0 legacy behaviors and identity. No secrets or new dependencies. Host owns
semantic state and time. Preview is isolated. Fence reset/pause/version races. Never
await inside database transactions. Never rewind consumed resources on compatible edits.
Deduplicate across restart. Distinguish accepted gameplay from cosmetic budget limits.

- [x] SDK + sandbox: write failing state/replay/admission tests, implement schemas,
      pure reducers, atomic engine integration, read-only session bridge and independent
      scenario verification. Own packages/sdk and packages/sandbox only.
- [x] Compiler: write failing generation/schema tests, extend strict structured output,
      prompt, examples/offline support and intent checks for both experience types.
      Own packages/compiler only; consume SDK contract.
- [x] Persistence + runtime: failing SQLite restart/concurrency/failure tests; migration,
      channel-scoped session journal/outbox, atomic state transitions, timers, reset and
      compatibility gates. Own apps/server plus migration; consume sandbox contract.
- [x] Web: failing UI tests; mirror wire contract, canonical private/live HUD, example
      prompts, preview joins/time controls, confirmed reset and state evidence. Own apps/web.
- [x] Integration review: full checks/build/bundle/smoke, restart/replay evidence,
      secret scans, fix actionable findings; update docs and focused conventional commits.

Progress and decisions are recorded here as work completes. No merge/push is part of
this feature request; retain the implementation on its feature branch.

## Verified results

201 trusted package/server/DOM tests and 15 tooling checks pass. Lint, strict types,
production build, bundle isolation, smoke checks and focused/Gitleaks secret scans
pass. Full suite was run: two existing socket integration tests fail on loopback
EPERM (EventSub ws transport and Twitch-to-overlay test); browser startup is blocked
by the same environment. A real compiler invocation failed before producing a
candidate due to workspace routing discovery; successful stateful model output is
not claimed. Both offline references pass actual verification/approval/live tests.

Fresh review fixes, each reproduced RED then GREEN: durable panic independent of
session writes; postcommit cosmetic errors preserve accepted progress; key rotation
keeps completed authoritative HUDs. Additional tests cover cross-round duplicate
identities, expired startup recovery and source-fault pause preserving resources.

Implementation choices: canonical bounded team-score/cooperative-goal definitions
rather than arbitrary guest state writes; deadline continues through normal downtime;
canonical-rule changes require explicit reset (F32 migration is separate); cosmetic
delivery is at most once and may be lost, with authoritative state resynced.
