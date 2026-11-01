# F35 implementation plan

Spec: ../specs/2026-11-01-visual-canvas-design.md
User requested direct implementation on main; preserve existing files and don't push.

## Task 1: scene contract and host lifecycle

Write failing contract/service tests, implement bounded scene types/validation,
normalized geometry, exact behavior binding, default scene, immutable revision storage,
CAS, review classification, apply/undo, and authenticated private API. Independent
host checks reject protected overlaps and forbidden primitives. Persist migrations.
Interfaces: GET /api/scenes/:versionId returns {state}; POST same with
{expectedRevision, scene, source:'direct'} returns {state}; POST /undo with
{expectedRevision,targetRevision}; POST /apply with {expectedRevision,digest};
POST /generate with {expectedRevision,selectionId,intent} returns {state}.
State: {versionId,artifactId,revision,digest,scene,classification:'review'|'configuration',
appliedRevision:number|null,history:[{revision,digest,scene,source,classification}],checks:string[]}.
Scene: {version:1,regions:[{id,label,kind,protected,rect}],nodes:[{id,kind,regionId,
rect,asset:null|'tomato'|'star'|'heart',timing:{trigger,delayMs,durationMs}}]}.
Rect normalized integers {x,y,width,height}, positive dimensions; max 12 regions/8
nodes, unique IDs and node kinds, max delay 60000ms/duration 60000ms; duration0
means persistent only for always. Critical nodes always visible. Default IDs:
camera,captions,gameplay,scoreboard-region; effects,scoreboard,instructions,celebration.
Verify: focused scene host and compiler tests green, types green.

## Task 2: contextual scene generation and live publication

Reuse injected compiler transport with optional strict response schema, bounded
queue and deadline/cancellation. Preserve default behavior compilation. Record real
vs offline provenance; accept only valid scene edits and recheck CAS after await.
Broker scene frames: {v:1,type:'scenes',payload:{scenes:[{automationId,versionId,
revision,digest,scene}]}}. Effect frames add optional automationId; session frames
already have automationId. Legacy broker tests remain compatible. Runtime publishes
only active scenes; panic/paused scene changes cannot activate content.
Verify: model boundary, stale results, channel ownership, live/private tests.

## Task 3: shared renderer and canvas

Web mirrors strict scene schema (no backend imports), renders trusted nodes in clipped
normalized boxes, uses shared scene geometry in preview/live. Write rendering and
UI tests first; implement editor numeric/pointer/keyboard changes, region properties,
timing tracks, undo/history, language context, review and apply. API response validation
fails closed. Selection/version changes cancel stale UI responses.
Integrate both rehearsal modes and overlay, with live identity routing, mobile view,
reduced motion and safe clear on all lifecycle events.
Verify: DOM tests, schema consistency fixtures, targeted Playwright/axe when sockets
available; production build and bundle boundaries.

## Task 4: review and delivery

Update README, setup status, ownership README and AGENTS with actual behavior and
limitations. Run lint/types/full tests/tooling/build/bundle/smoke/secret checks. Fresh
independent whole-change review, fix material findings with regression tests. Report
actual environment failures without claiming browser or real model execution.

## Review focus

Stale model results and stale approvals; cross-channel revision IDs; presentation
configuration cannot alter protection/timing/asset authority; active-version changes
must withdraw old scenes; clipped animations cannot cross protected regions; mobile
critical text cannot be hidden by overflowing bounds; panic clears pending timers.

## Execution evidence

Completed directly on main; no commits or pushes. Host work was delegated with
exclusive backend ownership; browser integration was implemented in the parent session.
An independent whole-change reviewer reported five material findings, all reproduced
and fixed with regressions in one fix pass. No deferred findings.

Decisions resolved during implementation:

- Copy a parent's exact approved scene into an authored descendant as immutable
  presentation-only approval. This prevents custom camera protection silently resetting;
  behavior activation still requires its existing verification and approval.
- Resolve critical-text areas across all active scenes before drawing cosmetic effects.
  Applying conflicting layouts is rejected; later activation conflicts fail closed.
- Page long instructions and crowded scores at readable font sizes in small views.
  Full text remains available to assistive technology; playback uses logical time.
- Bind scenes to existing behavior artifacts rather than adding guest capabilities.
  Behavior edits continue through the existing compiler and review pipeline.

Verification: 498 available tests, 15 tooling checks, lint, strict types, formatting,
build, bundles, smoke and redacted secret scans passed. The two localhost socket tests
and Chromium/browser execution remain environment-blocked; see setup-status.md for
precise failures. Runtime scene generation is covered with recorded/injected transport
and offline fixtures; no real-model execution claim. Source remains ready for review.
