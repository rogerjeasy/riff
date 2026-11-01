# Compiler fixtures

Store recorded, redacted structured outputs with provenance. Never import these files as host modules.

`stateful-experiences.json` records deterministic offline Tomato Battle and Community
Goal outputs for prompt pack `riff-compiler/4`. These are template responses, not
claims of live model generation. Both outputs pass the same sandbox verifier as
model responses. The test suite replays their compiler contract and explicit intent
checks without credentials or a model call.

`live-evolution.json` records the offline F32 edit and its separate migration source
for prompt pack 5. It preserves the old team/scoring rules and adds two throws to
the existing allowance; it is an offline recording, not a model execution.

`rehearsal-repair.json` is a host-authored deterministic recorded-test response for
prompt pack 6, with bounded private rehearsal evidence and a two-effect repair.
It records no live model call. Compiler contract tests validate the request/output;
server tests verify the response against immutable independent regression inputs.

`event-triggers.json` records the deterministic offline F19 outputs for prompt pack 7
(cheer, raid, gift, subscribe and resub intents, including "rain confetti" and "welcome
banner" requests whose missing effects are stated as projectile stand-ins). Prompt pack 7
only adds the Twitch event-trigger rules and curated event examples, so the host-authored
`rehearsal-repair.json` response is re-pinned to it unchanged. No live model call.
