# Interaction engine and private preview

Implements the first increment requested by the owner: host-enforced Tomato Toss
followed immediately by interactive preview. Product documentation and the owner's
implementation brief are the authority. Runtime generation, review/activation and
authenticated Twitch participation remain subsequent increments.

Use normalized chat events, an overlay projectile capability, command/audience/rolling
window admission rules, versioned manifests and structured decisions. Hosts enforce
rules independently of guest behavior. Guest outputs are staged and validated before
admission. Quota rejections do not disable an interaction; faults quarantine the run.

QuickJS executes in a supervised worker with memory, interrupt, bridge-call and wall
bounds. Each invocation gets a fresh runtime. Preview only runs the reviewed reference
artifact; HTTP callers cannot submit source. Each request reconstructs isolated state
from a bounded ordered replay. The console explains decisions and animates effects.

Approaches: a tomato-specific handler would not establish the execution contract;
implementing every capability first would delay observable verification. The chosen
increment runs source through a general bounded boundary with one supported capability.
Unsupported capabilities fail closed. Replay identity includes source, manifest, seed
and ordered input timestamps. No live sinks or credentials enter preview.
