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

Run `pnpm build:packages` before tests: workers execute the compiled JavaScript artifact.
See [the SDK](../sdk/SDK.md) for supported contracts and bounds.
