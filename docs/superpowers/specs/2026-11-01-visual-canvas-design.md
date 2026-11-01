# F35 — Intent-aware visual canvas

Implement the approved F35 roadmap directly on main, extending the existing studio.
The scene is a host-owned, versioned document bound to one exact behavior version and
artifact. Guest code receives no new capabilities. Both drag/property edits and
contextual language edits produce this same document. A shared browser renderer
consumes it in the canvas, quick proof, scenario rehearsal, and live overlay.

## Contract and choices

Scene v1 uses normalized integer rectangles on a 1000 × 1000 coordinate grid,
rendered in a 16:9 viewport. Regions have stable IDs, labels, kinds (camera,
captions, gameplay, scoreboard, custom), rectangles and protected flags. Nodes
have stable IDs, kind (effects, scoreboard, instructions, celebration), regionId,
rectangle, asset (tomato/star/heart or null), and timing (always, round-start or
round-end trigger; bounded delay and duration). Owned sprites and text-only trusted
primitives are the complete rendering vocabulary. No arbitrary markup, URLs or
scripts. Critical instructions and scores remain readable in mobile/reduced motion.

One durable scene head per behavior version uses revision CAS. Immutable revisions
retain exact document, digest, provenance, validation and review classification.
Up to 100 revisions/version. Updating within an approved node's region while
preserving regions, node identity/kind/asset and timing is a configuration revision.
Other valid changes require an explicit exact-digest review. Invalid geometry,
protected intersections, unknown assets and excessive timing are rejected even
when a creator asks to approve them. Applying requires the bound behavior still
be active and healthy, no panic, valid proposal lineage and expected scene head.
Rollback/undo creates a new revision, never rewinds the CAS counter.

Every viewport clips effects to validated safe node bounds, including trajectories,
splats and labels. An invalid scene frame clears prior presentation. Panic, pause,
rotation, version change and watchdog loss clear effects and timers. Preview has no
live write authority. Live publication includes automation/version identity so each
effect and session is rendered with its own exact scene. Legacy versions receive a
safe default scene.

## Language and verification

Selected region/node plus the current document and exact revision become quoted
compiler context. Use the existing injected model transport, queue and strict output
schema infrastructure for a bounded scene-only edit; model output never grants
permissions or activates a scene. Offline mode is explicitly labeled and supports
position/timing edits without pretending to understand arbitrary intent. Unsupported
behavior/capability requests direct the creator to existing authoring and review.
After any asynchronous generation, CAS is rechecked. Host validation and immutable
review evidence are independent of model explanations.

## UI and acceptance

Canvas selection, pointer drag, keyboard movement, numeric geometry/timing controls,
region protection, undo history, language edits, visible before/after review and
explicit apply. Stream/mobile and reduced-motion views use the same renderer.
F34 playback supplies logical time/session data; visual-only samples are labeled.
A Tomato Battle demo moves its scoreboard, protects camera/captions, positions a
round-end winner celebration, rehearses it, then applies exactly the reviewed scene.
Tests cover stale generation/approval, cross-channel IDs, panic/lineage, geometry,
clipping, time boundaries, round-trip edits, mobile/keyboard access and private sinks.

Alternatives considered: separate editor-only layouts would drift from live output;
putting arbitrary rendering code into guest modules would expand authority. A
bounded host scene bound to existing behavior artifacts preserves current safety.
