# Generated-code execution

The private preview engine validates manifests and ordered chat inputs, applies
host-owned rolling admission rules, and runs each handler in a fresh supervised
QuickJS worker. Effects are staged and validated atomically; no live adapter exists.
See ../sdk/SDK.md for supported contracts and bounds. Run `pnpm build:packages`
before tests because workers execute the compiled JavaScript artifact.

This is a narrow preview boundary, not the production activation lifecycle. Durable
state, shared channel budgets, generated-module lint/bundling and version approval
are not implemented yet.
