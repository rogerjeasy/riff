# Private rehearsal studio

`stage.tsx` keeps the immediate synthetic viewer controls and quick proof sequence.
Two mode tabs, **Quick proof** and **Scenario studio**, switch the same card; leaving
the studio cancels and unmounts private interactive work.

The studio reads top to bottom: scenario bar (pick, name, saved state, save), **Start
from** (plain-language presets or the live round), the **player** (stage with scores,
transport, outcome-coloured track, step list, inspector and verdict), then progressive
sections for **Edit inputs**, **Fix a failure**, **Saved regressions** and **Advanced**
(seed, origin, provenance and hashes). `labels.ts` holds every plain-language label:
preset names, step titles, outcome badges, check sentences and actionable errors.

- `studio.tsx` owns saved inputs, revision/dirty state and the single request/abort/
  epoch lifecycle. Server responses supply authoritative cursor state. Version and
  artifact identity key the component; cancelled or superseded responses cannot
  supply evidence. Only complete, nonempty, passing exact primary replay receives
  preview credit; comparison and reduction do not.
- `library.ts` owns independent scenario/regression list reads, publication freshness
  and complete authoritative refresh after every committed library mutation. An
  acknowledged change stays usable if refresh fails; a scoped error and Reload
  library / Reload regression library retry recover the complete retained list.
- `input-editor.tsx` edits normalized chat, roles, delivery duplication, logical
  delays and stateful host controls. Separate explicit expectations cover decisions,
  effect counts, phase, scores and participant resources. Native details keep these
  tools behind progressive sections; no JSON editor or executable source is needed.
- `timeline.tsx` (the player) presents Play/Pause, Previous/Next step, Reset timeline,
  Run to end, a keyboard range cursor and a clickable step list. **Play asks the host
  for one complete replay**, then animates its frames locally (≤600 ms a step, about
  15 s in total) and requests exact state only when paused mid-way; it previously
  issued one fresh replay per step (quadratic work and one stored run each). The
  cached complete replay is keyed by scenario revision, version, artifact, comparison
  and fresh-start choice, so **Run to end** from it is instant. Dragging the cursor
  shows frames immediately and asks for exact state once it settles. Frames carry the
  host's compact score/phase projection; full participant resources, checks and the
  session HUD come only from an exact response, never reconstructed in React.
  **+ Expect an outcome here** pre-fills an expectation from the selected step's
  actual outcome. The verdict summarises expectations and host safety checks in plain
  language, and **Fix this failure** opens the reduction flow on that check.
- `regressions.tsx` presents a three-step **Fix a failure** flow (shrink, keep as a
  regression, ask for a repair) and the **Saved regressions** library: failed-check
  selection/reduction, immutable regression saving, library rerun/delete and a
  reviewed explicit repair request. The studio's
  operation owner fences mutations and replay; library reads have independent freshness. Repair immediately hands the returned
  durable run to the existing app run store and normal candidate review workflow.
- `contracts.ts` mirrors strict bounded host wire shapes without importing server or
  sandbox packages. `lib/api.ts` applies existing guarded mutations, typed safe
  errors and abort signals. Candidate evidence renders the exact pinned regression
  set, including deleted records, independently of the current library.

Replay always binds a stored revision: Play, Run to end and step controls save unsaved
inputs first (one explicit save request, then the replay). Edits clear local evidence. Stale saves retain typed work; **Reload library** refreshes the saved
records; **Reload saved inputs** explicitly replaces the editor with the current
stored revision. **Import and save current round** durably saves the sanitized
capture before exposing it to edits, using the host recording selector. Later
journal growth cannot change that capture. Name-only saves preserve provenance;
input edits become derivatives of the exact saved capture on host update.

Import requires an actual active version/session identity from the app. Unsupported
journals, incompatible snapshots, operation capacity and size limits remain visible
errors. Fresh-start comparison is explicitly labeled and is separate from preserving
migration approval. Reduced and rerun inputs become an unsaved scenario for inspection;
their immutable run is still available for regression saving. New scenario saves
retain that run as `sourceRunId` through edits; the host resolves ownership and
grants unchanged provenance or an exact-source derivative. If the source was
pruned, the save fails safely and typed inputs remain available. Reduction reports its
24 replay / 2400 step budget and makes no global-minimality claim.

No rehearsal output reaches live sinks. Saving and reducing never generate code;
repair never activates a candidate. Reduced motion is passed to local effects.
DOM/API tests cover editing, canonical imports, lifecycle locks, seek/reset/play,
late responses/navigation, exact preview gates, comparison, checks, bounded errors,
regression/repair and immediate app handoff. Root integration owns browser attempts.
