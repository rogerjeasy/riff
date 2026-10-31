# Riff SDK 0.2.0 — private preview contract

Compatibility: 0.1.0 had no executable capability API. Version 0.2.0 introduces the
preview bridge; manifests must explicitly specify 0.2.0. Live execution is unavailable.

Source is a JavaScript handler expression `(event, riff) => void | Promise<void>`.
This is the execution target for a future restricted TypeScript bundler. Imports,
external module loading, ambient clocks, randomness, network and filesystem are
unavailable. Invocation globals never survive the next event.

`ChatEvent`: id, channelId, viewerId (nonempty strings <=100 chars), roles (viewer,
subscriber, moderator, broadcaster), text (<=500 chars without control characters),
at (ordered host observation milliseconds). Preview roles are explicitly synthetic;
a live adapter must derive identity and roles from authenticated platform events.

`PermissionManifest`: sdkVersion; capabilities (`overlay` only); trigger {command,
audience, maxPerViewer, windowMs}; limits {effectsPerEvent, effectsPerMinute}.
An exact trimmed command match is required. Audience matches any listed role.
Rolling windows retain accepted actions where timestamp > now - windowMs; duplicate
identities, irrelevant commands and blocked actions never spend viewer allowance.
Each admitted handler with effects spends one action even if it emits multiple effects.
Limits are host enforced even when the handler omits all checks.

`riff.overlay.emit(effect): Promise<void>` stages a projectile with kind `projectile`,
asset `tomato` or `star` and normalized x between 0 and 1. Example:
`await riff.overlay.emit({kind:'projectile', asset:'tomato', x:0.5})`.

`riff.util.now(): number` returns event.at. Example: `const at = riff.util.now()`.
`riff.util.random(): number` advances a seeded xorshift32 sequence in [0,1).
Example: `const x = riff.util.random()`.

No state capability is enabled. Unsupported manifests fail closed. All effects are
validated, staged and discarded on any invocation fault, including caught bridge
rejections. Resource violations quarantine a preview; ordinary quota decisions do not.
Call results are instrumented and observed, including detached async calls. Any
observed rejection or pending promise quarantines the run, even if guest code
catches it; this deliberately strict subset has no external async work. Reserved
`__riff` bindings cannot occur in guest source. The host allows at most 256 observed
call results and 100 pending jobs per invocation.

Each preview is limited to 256 unique event identities; start a new isolated session
when full. Preview output carries mode `preview` and cannot address a live sink.

Artifact identity hashes parsed source/manifest, policy version and resource ceilings.
Replay also requires the seed and ordered original events, including role observations.
The runtime has a 64 MB QuickJS heap, 50 ms worker CPU budget checked by the interrupt handler, 2 s supervisor wall
deadline, 25 bridge calls, 10 effects/event hard ceiling and 120 effects/minute hard
ceiling per isolated preview channel. Worker CPU is measured with Node
[threadCpuUsage](https://nodejs.org/docs/latest-v22.x/api/process.html#processthreadcpuusagepreviousvalue),
excluding trusted runtime setup; the parent supervisor independently bounds handler wall time. Trusted worker/WASM
startup has a separate 10-second limit and must send readiness before the two-second
handler wall clock begins. Startup failure still quarantines that preview. No durable live or cross-automation budget exists
in this increment. Admission and dispatch are serialized within each engine.
