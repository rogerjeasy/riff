# Private rehearsal

`service.ts` owns bounded saved scenarios, immutable prefix/compare runs, journal
imports, minimized counterexamples and retained regressions. `preview.ts` preserves
the existing quick proof API. No rehearsal service accepts a live runtime, admission
repository, outbox, hub or overlay sink. Exact owned versions resolve server-side;
clients never submit executable source or recorded provenance.

Every seek replays a prefix from the fixed origin in fresh engines. Cursor zero is
initial state; cursor N is final state. Comparisons share inputs and seed, compare
codes/allowance/reasons, cosmetic effects and semantic state separately, and refuse
incompatible initial snapshots unless the creator chooses a labeled fresh start.
Minimization requires a complete immutable failed side and binds its evidence hash,
selected version/artifact and exact failed check. It stores a new immutable run;
saving a regression copies all input and evidence, so scenario deletion and bounded
run-history pruning cannot erase it.

Private routes under `/api/rehearsals` use strict Zod, the existing same-origin
creator mutation guard and no-store. Scenarios revision-check updates and deletion.
Bounds are 120 steps, 20 explicit checks and 128 KiB per scenario; 50 scenarios,
100 runs and 50 regressions/channel, with 10 regressions per automation. One expensive
operation/channel includes both API work and authoring regression batches, with a
60-second timeout, request cancellation and awaited shutdown. Sandbox minimization
also enforces 24 replays and 2400 steps. History prunes oldest records; full scenario
or regression libraries report a safe limit error rather than silently deleting them.

Recording import reads at most 122 journal entries atomically with the version,
requires a valid single-version start and at most 120 complete steps, and refuses
migration-spanning or oversized input. It replaces account/event/channel identities,
keeps duplicate relationships and roles, and replaces unrelated chat with a fixed
marker. Only recognized contribution/join commands survive. Saved recordings can be
created through the host recording selector or unchanged copies of an owned durable
run. The studio imports directly into a saved capture, so later journal growth cannot
change its origin. New scenario saves may supply `sourceRunId`; the host resolves the
channel-owned immutable run and preserves its provenance only for unchanged inputs.
Changed inputs become synthetic derivatives of that exact source hash. Name-only
updates preserve provenance; input edits to stored recordings/derivatives bind their
prior hash. Client provenance must still be synthetic, and the full 128 KiB bound is
checked after host metadata is assigned. Missing or pruned sources fail closed.
Cosmetic randomness after anonymization is not a byte-identical live audit. Existing session audit is separate.

Authoring pins applicable ancestor regression records before queueing. Bounded
quoted JSON evidence goes to the compiler in `rehearsalContext`, independently from
creator intent. Host replay retains the original expectations and stores exact
results in `evidence.rehearsal`; any failure sets the existing verification.ok=false.
The existing single automatic repair and F33 ancestry checks remain authoritative.
Explicit repair starts an ordinary candidate from the regression origin version;
rehearsal never compiles implicitly, approves or activates a version. New regressions
do not retroactively revoke older approvals.
