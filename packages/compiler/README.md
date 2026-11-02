# Runtime compiler

Validation and orchestration. Transport ownership remains in apps/server.

See the root README for commands and docs/tech-stack.md for the complete architecture.

Prompt pack `riff-compiler/4` supports SDK 0.4.0 canonical experiences in the same
structured candidate contract as projectile interactions. Model manifests always
include `experience` (null for projectiles); existing stored 0.3.0 artifacts remain
supported by the downstream verifier. Session handlers read a frozen snapshot and
emit visuals; the host owns joins, resources, scores and deadlines.

The offline template compiler remains explicitly labeled. It supports Tomato Battle
(Red/Blue joins, !throw, three resources, 120 seconds, highest score) and Community
Goal (!grow auto-enrollment, three contributions, 120 seconds, target five), plus
bounded command/duration/resource/goal edits. It asks for missing join or contribution
commands and rejects additional mechanics rather than dropping them. Projectiles and
existing Tomato Toss edits retain their rolling allowance behavior.

The strict model output schema supports nullable phase/time assertions on generated
scenario steps. Offline scenarios additionally carry host-supported score/resource
subset assertions. Dynamic score/participant maps are omitted from the model schema
because strict model objects require fixed properties; the independent host policy
suite always verifies canonical resources and scores. Recorded offline fixtures are
under `fixtures/`, with provenance that makes their source explicit.

Prompt pack `riff-compiler/7` adds named host timers (capability `timer`, F18): the
prompt no longer lists general timers as unsupported, curated examples add a repeating
hydration reminder and a one-shot countdown celebration, and strict scenario steps
carry a nullable `timers: {fired, effects}` assertion. The offline compiler handles
explicit "every N minutes" (repeating) and "in/after N seconds" (one-shot) phrasing
between 5 seconds and 1 hour; counted allowances such as "once every 30 seconds"
stay rolling windows. A `timer` intent-check row compares the stated and scheduled
interval. Timers inside stateful experiences remain unsupported.

Prompt pack `riff-compiler/9` combines the timer, Channel Points/Predictions and F31
version 2 mechanics rules (burst, health/elimination, best-of-N, milestones) in one
prompt; the curated examples add Shield Wall and Castle Siege.

Prompt pack `riff-compiler/10` adds the F21/F23 native Twitch action rules (capabilities
`polls`, `chat.announce`, `shoutout`) to the same prompt and removes polls and shoutouts
from the unsupported list; the offline compiler chains native-action, session, Channel
Points/Predictions and timer templates.

Prompt pack `riff-compiler/11` adds the F19 Twitch event-trigger rules (`trigger.event`
with the reserved `@kind` command, per-step `twitch`) and curated cheer/raid examples;
the strict schema now carries `trigger.kind`, `trigger.reward` and `trigger.event` together,
and the validator rejects a trigger that sets both `points.redeem` and `event`.

Prompt pack `riff-compiler/12` unifies the trigger model: `trigger.kind` is the single
discriminator (`chat.command` | `points.redeem` | `twitch.event`); `reward` belongs only
to `points.redeem` and `event` only to `twitch.event`. TASK_RULES has one "Trigger kinds"
section and the offline event compiler emits `kind: 'twitch.event'`. The same pack adds the
host-owned raider shoutout rule (`riff.shoutout.raider()` from a raid trigger only); the
offline compiler handles "when we get raided, shout out the raider" and refuses automatic
shoutouts on any other event.
