# Capability bridge

`guest-worker.ts` installs the JSON-only `overlay` and `session` capabilities.
Every handler gets a fresh QuickJS context. Overlay emits require a declared capability
and bounded validated projectile payloads. `riff.session.snapshot()` requires declared
`session` authority and a canonical staged snapshot. The returned object and all nested
data are deeply frozen; enrollment, resources, scoring and round clocks remain host-owned.
No persistent guest globals, arbitrary mutable store, filesystem or network are exposed.

`riff.polls.start/end`, `riff.chat.announce` and `riff.shoutout.send` stage strict,
bounded native Twitch actions (capabilities `polls`, `chat.announce`, `shoutout`). They are
never executed in the isolate: the decision carries them and only the live host sends them.
