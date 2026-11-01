# F34 — Interactive rehearsal studio

Direct implementation requested on main after F33; no further design checkpoint.

## Outcome

Creators save a private scenario, inject supported normalized inputs, play/step/seek
its timeline, inspect decisions and state, compare two exact versions, minimize a
failure and retain it as an independent regression. A deliberate repair request
creates an ordinary candidate; existing verification, rehearsal and exact-version
approval remain authoritative. Reference: Tomato Toss and Tomato Battle bursts,
duplicates, exhaustion, late arrivals, deadline, and the !splat/add-two edit.

## Approach and scope

Use prefix replay from a fixed origin in fresh preview engines. This reconstitutes
host admission/dedupe/budgets and deterministic per-event randomness as well as
session state; restoring only a scoreboard would be wrong. No live engine or sink
is injected. No mutable checkpoint cache is needed for a bounded120-event scenario.
A timeline cursor counts events already applied:0 is initial state and N is final.
Play/pause are presentation controls; scenario pause/resume are explicit host events.
Backward seek clears old animation and never emits live effects.

The existing SDK remains unchanged: rehearsal is a host feature, not a guest power.
No dependencies, Twitch scopes, EventSub shapes or network adapters are added.
Unsupported raid transport is not invented: an audience surge is explicitly synthetic
normalized chat. Existing quick proof preview and F32 migration review remain usable.

## Reusable execution contract

In packages/sandbox add a version1 bounded scenario with seed1..2^32-1, initialAt,
nullable initialSession, ordered steps and expectations. Each step has a unique key
independent of delivery identity. Chat steps carry the existing ChatEvent shape;
advance/pause/resume steps carry logical at. Duplicate delivery IDs are allowed.
Controls cannot rewind the logical clock; out-of-order chat can be tested and must
produce the actual host rejection. Replays never reorder inputs. Stateful controls
use existing pure session functions and restore only within the same private engine;
stateless time advance is valid, stateless pause/resume are rejected.

Limits:120 steps,20 explicit expectations,128KiB serialized scenario,50 saved
scenarios/channel,100 retained runs/channel,50 saved regressions/channel and10
applicable regressions/automation. Run responses use compact timeline frames plus
one full cursor state, not120 full256-participant snapshots. Bound summary/error
strings and result size. One active expensive operation/channel; service timeout60s,
request cancellation and app shutdown release workers/slots. Minimization at most24
replays and2400 dispatched steps, retaining the same failure identity; report attempts
and whether the budget stopped reduction. No claim of global minimality.

A result identifies exact artifact, scenario hash, host/fixture contract version,
seed, cursor, decisions, state digests and checks. No wall-clock duration participates
in deterministic evidence. Automatic checks catch quarantines and host consistency
failures; expected quota rejections are ordinary outcomes, not safety failures.
Explicit expectations address a stable step key and can check decision code, effect
count, phase, team score and participant remaining resources. Distinguish creator
expectation mismatch from a host invariant failure. A passing rehearsal proves only
its particular inputs and checks. Expected and actual results are independently
compared by host code, never by generated tests alone.

Comparison uses identical scenario input and seed in two fresh engines; each side
reports exact artifact identity and own outcome. An explicit initial snapshot must
validate against both definitions or comparison is refused with a fresh-start option.
Fresh-start comparisons are clearly labeled; they are not live migration evidence.
Compare codes, effects and semantic state, excluding artifact IDs and timing telemetry.

## Persistence and private API

Add generated migrations and channel-scoped repositories for rehearsal_scenarios,
rehearsal_runs and rehearsal_regressions. Scenario edits require expectedRevision;
run and saved regression evidence is immutable and binds exact versions/artifacts,
scenario revision/content, inputs, checks and origin. Keep run history bounded by
pruning oldest records; scenarios/regressions cap with explicit errors and deletion.
Deleting a scenario does not erase a retained regression. No live version activation
or session/admission/outbox writes occur during any rehearsal operation.

Routes under /api/rehearsals use strict Zod schemas, no-store responses and the
existing local-creator mutation guard. Version IDs resolve only in the current
channel; clients cannot submit executable source or declare recorded provenance.
Implement scenario list/create/get/revision-update/delete, run/seek/compare, presets,
private recording import, run inspection/minimize, save/list/delete/rerun regression
and explicit repair generation. Report exact endpoint/body contracts to the UI task.
Use a route-local256KiB request cap while enforcing128KiB scenario bound.

Presets based on the chosen manifest cover proof, crowd burst, duplicate delivery,
late arrival, exhaustion and deadline; cap their generated steps before execution.
Custom injection supports viewer identity/roles, command, delay and expected outcome,
plus explicit clock advance and pause/resume for stateful experiences.

Recordings come from the server's existing session journal, read atomically with
its version/session identity. Import a complete single-version journal of at most120
steps with a valid start; reject unsupported migration-spanning or oversized journals
explicitly, never pretend a truncated recording is complete. Anonymize viewer and
event IDs consistently, preserve duplicate relationships and roles, replace channel
identity with a private rehearsal channel, and keep only recognized interaction/join
commands; other text becomes a fixed unrelated marker. Do not send raw account IDs,
names, original chat or tokens to the client, compiler or logs. Mark imported data
as a sanitized recording with a pinned origin; sanitized cosmetic randomness may
differ from the live run, so it is not represented as a byte-identical live audit.
Edits/injections into a recording become a synthetic derivative with provenance.

## Counterexample and repair

Minimization starts from a stored immutable failed run and its selected failed check.
Keep that check/step fixed, remove irrelevant inputs only when the same failure still
reproduces, rerun the final result and retain a concrete reduced scenario. Never let a
later incident or different assertion count as reproducing the selected failure.
Save the reduced scenario as an immutable regression (name, expectation, provenance,
origin version, artifact and failed evidence). Rerun on another owned version through
the same host pipeline. A missing/incompatible initial snapshot must fail visibly.
If no inputs can be removed within the bounds, retain the original valid scenario
and provenance. Changed scenarios carry derivative provenance only when the complete
result still fits the scenario byte cap; metadata growth cannot invalidate the origin.

Repair is a separate explicit creator action naming a regression and reviewed intent.
Pass bounded JSON evidence as data in a distinct optional compiler request field,
without polluting intent extraction or granting chat instructions authority. Update
prompt version/tests and add a recorded repair fixture. Independent host verification
reruns saved applicable regression scenarios for future descendants of their origin
version, including the repair. Pin the selected regression set for each compile and
persist those exact results in candidate evidence; generated tests cannot rewrite
expectations. A failed regression makes the candidate unapprovable through existing
verification blockers and allows only the existing single automatic repair attempt.
Newly saved regressions do not retroactively revoke prior approvals; evidence names
exactly which were checked. F33 ancestry checks still apply to every repair/edit.
Rehearsal never automatically starts generation or activates a version.

## Creator UI

Extend the current private stage with an advanced studio entry, keeping quick proof
usable. Offer saved scenarios and presets, explicit seed/origin, scenario saving,
injection, a keyboard-accessible timeline slider and play/pause/step/reset controls.
Inspect selected event, logical time, accepted/blocked explanation, allowance, session
scores/resources/phase and expectation checks. Seeking clears obsolete effects.
Choose a comparison version and see synchronized differences at the same cursor.
Version/scenario changes, edits, navigation and late responses invalidate old evidence;
abort obsolete requests and never mark another version previewed. No editing while
an operation commits against a different scenario revision. Empty/loading/failure,
quota, cancellation and incompatible comparison states are explicit.

Provide failure selection, reduce, save regression, regression library/rerun and a
reviewed repair request. Candidate handoff uses existing run/evidence/rehearsal review,
never a direct approval button. Make privacy and synthetic/recorded labels visible.
Respect reduced motion, native labels/focus and existing responsive design.

## Acceptance and verification

Replaying/seeking/restarting identical inputs reproduces decisions, effects, digests,
state, dedupe and allowances; branches cannot inherit future admission. Comparison
uses matching inputs. Minimized output reproduces the same selected failure, budgets
are bounded, and stored regressions survive restart and block an incorrect repair.
F33 removed ancestors cannot be bypassed through repair. Real temporary SQLite tests
prove channel isolation, stale revisions, recording sanitization and no live writes or
broker dispatch. UI tests prove controls/seek/late-response/injection/repair handoff.
Run full lint/types/tests/build/bundles/smoke/tooling/secrets; report known loopback and
browser restrictions separately, never as passes. No live model/Twitch claim without
an actual run. Group focused conventional commits; do not push unless asked.
