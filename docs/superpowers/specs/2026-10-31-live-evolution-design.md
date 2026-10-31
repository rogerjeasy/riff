# F32 — Live evolution with state preservation

Status: approved implementation design. Work stays on `main`, as requested.

## Intent and reference interaction

Let a creator revise an approved experience while preserving declared progress.
The reference edit is: “Change the command to `!splat`, keep everyone's teams and
scores, and give each player two additional throws.” The same verification and
approval pipeline must handle generated edits and rollback.

Existing sessions, durable admission, and the round journal are the foundation.
Current activation rejects any changed canonical definition unless reset is
explicitly approved. F32 replaces that binary choice with verified transitions.

## Approaches

1. Automatically copy state into a new definition. Simple, but existing invariants
   couple resources to contributions and scores to points; copying can corrupt play.
2. Use a versioned transition contract, restricted migration execution, independent
   host validation, and exact approval. This is the recommended approach, matching
   the feature proposal accepted in conversation.
3. Reset on every semantic change. Already available; retained as an explicit fallback.

## Contract and trust boundary

Add a host-facing `SessionTransitionPlan` in the dependency-free SDK. It contains
the contract version, source and target artifact identities, source and target
definition hashes, activation boundary, preservation requirements, explicit reset
declarations, and the migration source hash. The executable migration is a separate
immutable artifact. The host computes hashes; model-provided hashes have no authority.

Classify changes as identical-definition, migration-required, or reset-required.
Identical-definition edits preserve the existing behavior. A migration-required
change must pass independent validation. Unsupported state transformations remain
inactive unless explicit reset consent is supplied.

Migration receives deeply frozen copies of the old definition, new definition,
current snapshot, and an explicit host timestamp. It returns JSON only. Run it in
a separate QuickJS worker with memory, CPU, wall-time, input/output size and source
limits. It has no capability bridge, network, filesystem, effects, timers, clock or
random source. Reject invalid syntax, traps, excessive output and invalid snapshots.
Use existing sandbox hard caps or stricter caps; no new dependencies.

Host validation independently checks both definitions, the resulting snapshot,
identity, monotonic revision, phase/time consistency and every declared preserved
field. Migration cannot modify admission records, dedupe identities, already claimed
effects, credentials or external state. Reject participant removal, score rewrites,
team reassignment and resource loss in preserving migrations. If preservation is
impossible, offer the existing full-session reset, explicitly listing all lost progress
and requiring consent. Partial category resets are outside this increment because
scores, contributions and resources are coupled. Never silently reinterpret an old
score under a changed points multiplier.

For the reference edit, increase `resource.perParticipant` by two and each existing
participant's remaining resources by two, preserving contributions, scores, teams,
session identity and remaining time. New participants receive the new total allowance.
Initially support preservation only where the existing snapshot invariants can
represent it; transformations requiring a richer scoring model require visible reset.

## Rehearsal and evidence

Read the source version, session snapshot and journal consistently. Build a private
transition preview with source session id/revision/digest, hashes of all artifacts,
preservation checks, migration result, and a bounded comparison of both versions
using identical recorded or explicitly synthetic inputs, timestamps and random seed.
Clearly distinguish past recorded inputs from hypothetical future scenarios.

Show `preserved`, `changed`, `reset`, and `takes effect`, with before/after command,
audience, resource, scoring and timer rules. All candidate permissions still pass
the existing verification suite. Migration tests add empty, populated, exhausted,
paused and finished snapshots plus adversarial inputs. A passing model-written test
cannot substitute for host preservation checks.

Rehearsal must never call live repositories or sinks. Store bounded evidence and
counterexamples; cap comparison inputs and concurrent preview work.

## Activation and concurrency

Approval binds the candidate artifact, transition artifact, evidence identity,
source live version, session identity, and boundary. Reject stale source artifacts,
session replacement/reset, changed plans or missing evidence.

Support three boundaries: immediate, round-end, and stopped. For immediate changes,
serialize with chat/ticks, take the latest state, rerun the approved migration and
all host checks, then compare-and-swap its revision in one transaction with version
activation, transition status and journal append. A revision change during execution
fails without writes; it does not discard accepted chat. Rehearsal revision is evidence,
not a frozen state that replaces current progress. Show that new chat is revalidated.

Round-end approval is persisted as a pending transition. Apply only after the round
finishes, against that final snapshot; if already finished, apply immediately after
validation. This does not introduce recurring tournaments
or automatically start a new round; any fresh round requires explicit reset/start.
Stopped transitions require an already-paused interaction at approval and activation;
they remain paused afterward until explicit resume. They do not wait for a future
pause. Global panic blocks all activation.
Persist pending state across restart; panic cancels pending activation and requires
fresh approval. Manual version changes/reset invalidate incompatible pending plans.

Prepare the target engine before database activation. Fence old work, then atomically
commit the state/version and replace the engine before accepting more ingress.
No old-version timer or effect may deliver afterward. On storage failure keep the old
version/state; on unrecoverable runtime setup failure pause safely. On restart rebuild
the engine from the committed version/state and discard stale cosmetic effects.

## Rollback and audit

Rollback is another reviewed transition from the current state to an earlier approved
artifact. It never restores an old snapshot. If earlier rules cannot represent the
current resources or scores, require explicit reset rather than silently deleting them.

Extend the immutable journal with transition entries carrying old/new definition
identities, migration identity, explicit timestamp and resulting digest. Audit begins
with the original definition and validates each migration before replaying later chat
with the relevant version. Missing artifacts report unavailable; invalid evidence
reports divergence. Preserve existing journal compatibility.

Align replay randomness with live execution as a prerequisite: live derives its seed
from the session id while audit currently uses `1`. Record or derive the same replay
inputs in both paths and test a handler whose acceptance depends on randomness.

## Implementation sequence and file ownership

1. SDK transition types/documentation and sandbox schema, classifier, effect-free
   runner and preservation tests (`packages/sdk`, `packages/sandbox/src/transition.ts`).
2. Journal seed fidelity and transition replay (`packages/sandbox/src/journal.ts`,
   session repository and audit tests).
3. Durable transition evidence/pending status through a new generated Drizzle migration,
   scoped repository, transition service, serialized runtime activation and rollback
   (`apps/server/src/services/live`, `services/automations`, `routes/studio.ts`).
4. Structured compiler output, intent checks and offline reference edit using the same
   host pipeline (`packages/compiler` and server authoring service).
5. Review card, comparison, boundary selection, pending/cancel states and rollback
   evidence (`apps/web/src/console/review`, `console/live`, API types).
6. End-to-end workflow, hostile migration and recovery tests; update AGENTS, SDK guide
   and README to describe only verified behavior. Keep tests with each implementation
   slice and use multiple conventional commits without attribution trailers.

## Acceptance and verification

- Reference edit keeps scores/team membership/contributions and adds exactly two
  remaining throws; old command stops working and new command works.
- Concurrent chat during review is retained; reset/replacement invalidates stale review.
- Invalid output, undeclared resets, hostile migration and failed writes leave the
  current version and semantic state unchanged.
- Pending boundaries survive restart, respect stop/panic and never fire twice.
- Old effects cannot cross activation; durable abuse counters never refill on migration.
- Rollback preserves compatible current progress or visibly requires reset.
- Audits reproduce rounds spanning multiple definitions, including random-dependent
  decisions; comparison produces no live effects.
- Run lint, typecheck, host tests, tooling tests, build, bundle checks, smoke and secret
  scans. Browser/socket tests require an environment that permits local listening;
  report environmental failures separately rather than claiming they passed.

Builder decisions: reuse existing error/status/UI conventions and choose exact local
helper names. No external service, new dependency, scoring-schema overhaul, audience
proposal system or recurring multi-round scheduler is part of this feature.

Design review resolved three defaults: full reset rather than partial reset when
preservation fails, already-paused activation that remains paused, and immediate
validation/application of round-end transitions on already-finished rounds.
