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
`riff-compiler/7` (re-labelled `riff-compiler/9`): Shield Wall (distinct-viewer burst objective), Castle Siege (team
health and elimination), a best-of-3 Tomato Battle and Community Garden (milestone
unlock). They are template responses, not live model output; server tests run each
through the full verifier including the independent version 2 host suite.

`rehearsal-repair.json` is a host-authored deterministic recorded-test response for
prompt pack 6 (refreshed unchanged for pack 7, which only adds named timers), with bounded private rehearsal evidence and a two-effect repair.
It records no live model call. Compiler contract tests validate the request/output;
server tests verify the response against immutable independent regression inputs.

`named-timers.json` records the deterministic offline F18 outputs for prompt pack
`riff-compiler/7`: a repeating hydration reminder and a one-shot countdown celebration.
They use capability `timer`, branch on `event.source === 'timer.fired'` and assert
fires with step-level `timers` data. Offline recordings, not model executions; the
compiler contract test replays them and server tests run them through the verifier.

`channel-points-predictions.json` records deterministic offline outputs for prompt pack
`riff-compiler/7`: a `points.redeem` Hydrate redemption and a `predictions` proposal. They
are template responses, not model executions; the test suite replays them exactly.

`twitch-actions.json` records the deterministic offline outputs for prompt pack 7's
native Twitch actions: an owner-only poll, a viewer-triggered announcement and a
fixed-target shoutout. The compiler test replays them byte for byte and the server
capability-sync test verifies each through the sandbox pipeline. No live model call.

`event-triggers.json` records the deterministic offline F19 outputs for prompt pack 7
(cheer, raid, gift, subscribe and resub intents, including "rain confetti" and "welcome
banner" requests whose missing effects are stated as projectile stand-ins). No live model
call.

`riff-compiler/8`: merges the timer and Channel Points/Predictions rules into one prompt pack; the two recorded fixtures above were re-labelled with no content change.

`riff-compiler/9`: merges the F31 version 2 mechanics rules into the timer and Channel Points/Predictions pack; `named-timers.json`, `channel-points-predictions.json`, `stateful-mechanics.json` and `rehearsal-repair.json` were re-labelled with no content change.

`riff-compiler/10`: merges the F21/F23 polls, announcements and shoutouts rules into the same pack; `twitch-actions.json` and every fixture re-labelled for pack 9 were re-labelled again with no content change.

`riff-compiler/11`: merges the F19 Twitch event-trigger rules and curated cheer/raid examples into the same pack; `event-triggers.json` and every fixture re-labelled for pack 10 were re-labelled again with no content change.

`riff-compiler/12`: unifies the trigger model under one discriminated `trigger.kind` (`chat.command`, `points.redeem`, `twitch.event`). `event-triggers.json` was regenerated so each event trigger carries `kind: "twitch.event"`; every other fixture was re-labelled with no content change (chat and Channel Points identities are unchanged).

`riff-compiler/13`: adds the F31 version 3 formats. Every fixture labelled for pack 12 was re-labelled with no content change.

`stateful-formats.json` records the deterministic offline outputs for prompt pack
`riff-compiler/13`: "Let chat paint a 8x8 pixel mural with !paint", "Let chat compose a song
in three stages: tempo, instrument, mood" and "Run a 3-question quiz about the solar system
with !a !b !c". Template responses, not model output; compiler tests replay them byte for
byte and `apps/server/test/formats-pipeline.test.ts` runs each through the full verifier
including the independent version 3 host suite.

`raid-shoutout.json` records the deterministic offline F23 raider-shoutout outputs for prompt pack `riff-compiler/12`: "When we get raided, shout out the raider and show a welcome burst", a 20+ viewer raid variant (both `riff.shoutout.raider()` with a host-bound target) and the refusal of a shoutout on a cheer. No live model call.
