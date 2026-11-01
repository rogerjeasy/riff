# Generated-code execution

The live and private preview engines validate manifests and ordered chat inputs, enforce
host admission, and run each handler in a fresh QuickJS runtime/context in a supervised
worker. Calls and effects are validated and staged before returning to the server.

Legacy projectiles use rolling viewer allowances. SDK 0.4.0 sessions use canonical
bounded definitions, lifetime participant resources, immutable teams and host clocks.
Pure helpers create/advance/pause/resume snapshots. `engine.session` returns a copy;
`restoreSession` validates phase, time, resources and derived scores against the rules.
A handler reads the staged state through `riff.session.snapshot()`, which requires the
`session` capability and returns a deeply frozen JSON object. Guest faults discard the
entire staged contribution. Cosmetic channel budgets suppress visuals without dropping
valid gameplay progress. Durable transactions and external effect delivery belong to
the server, which restores committed state before dispatch and on transaction failure.

Generated scenarios may assert canonical phase, scores, remaining time and participant
resources. The independent host suite derives session admission, deadline, resource,
duplicate, audience and reachable bounded cooperative target checks from the manifest.
Call `advanceSession(snapshot, at, definition)` (or `pauseSession` with the same third
argument) to report `winner:null` for an expired cooperative goal that was not reached.

F34 rehearsal uses `runRehearsal({artifact, scenario, through, signal})`. A cursor
counts applied steps; zero is the fixed origin. Every request creates a fresh private
engine and replays that prefix, restoring admission windows, duplicate identities and
seeded effects along with session state. Chat delivery IDs may repeat; scenario step
keys must be unique. Explicit advance/pause/resume controls cannot rewind the clock.
Results contain compact timeline decisions, one cursor snapshot, deterministic hashes,
explicit expectation checks and automatic quarantine/consistency checks. Each frame
also carries a `summary` (phase, remaining time, scores, winner) so a client can play
back a whole replay from one request. Each frame's `stateDigest` already binds that
state, so the presentation projection is excluded from `evidenceHash`; evidence
identities did not change when it was added.

`createRehearsalPreset` supplies proof, crowd-burst, duplicate-delivery, late-arrival,
exhaustion and deadline inputs from the artifact's manifest. Scenarios are bounded to
120 steps, 20 expectations and 128 KiB; results to 256 KiB. The SDK guest surface is
unchanged. No live engine, repository or destination is accepted by these APIs.

`minimizeCounterexample` preserves the selected check's identity, expected value and
actual failure while removing inputs. Its 24-replay/2,400-step budget includes baseline
and final validation. The returned counters and `budgetStopped` explain the reduction;
the result is not a claim of global minimality. Cancellation stops the private worker.
The server owns deadlines, channel concurrency, persistence and recording sanitization.

Run `pnpm build:packages` before tests: workers execute the compiled JavaScript artifact.
See [the SDK](../sdk/SDK.md) for supported contracts and bounds.
