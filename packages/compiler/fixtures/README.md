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

`stateful-mechanics.json` records deterministic offline outputs for prompt pack
`riff-compiler/7`: Shield Wall (distinct-viewer burst objective), Castle Siege (team
health and elimination), a best-of-3 Tomato Battle and Community Garden (milestone
unlock). They are template responses, not live model output; server tests run each
through the full verifier including the independent version 2 host suite.

`rehearsal-repair.json` is a host-authored deterministic recorded-test response for
prompt pack 6 (provenance refreshed to pack 7, whose change does not affect it), with bounded private rehearsal evidence and a two-effect repair.
It records no live model call. Compiler contract tests validate the request/output;
server tests verify the response against immutable independent regression inputs.
