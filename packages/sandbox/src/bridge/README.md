# Capability bridge

`guest-worker.ts` installs the JSON-only `overlay`, `session` and `timer` capabilities.
Every handler gets a fresh QuickJS context. Overlay emits require a declared capability
and bounded validated projectile payloads. `riff.session.snapshot()` requires declared
`session` authority and a canonical staged snapshot. The returned object and all nested
data are deeply frozen; enrollment, resources, scoring and round clocks remain host-owned.
No persistent guest globals, arbitrary mutable store, filesystem or network are exposed.
`riff.timer.start/cancel` (capability `timer`) only stage validated operations that the
host applies after the handler succeeds; the guest never holds a callback or native
timer. Host fires re-enter the same handler as `timer.fired` events through
`engine.dispatchTimer`; previews use `createVirtualTimers` (`../timers.ts`).

`riff.predictions.propose()` requires declared `predictions` authority, accepts one
strictly validated proposal per event and only returns it in the decision; opening and
settlement are creator actions in the host console.

`riff.polls.start/end`, `riff.chat.announce` and `riff.shoutout.send` stage strict,
bounded native Twitch actions (capabilities `polls`, `chat.announce`, `shoutout`). They are
never executed in the isolate: the decision carries them and only the live host sends them.
`riff.shoutout.raider()` takes no argument: for a `raid` `twitch.event` trigger handling a
raid event, the bridge binds the target to the event's raiding broadcaster
(`{kind:'shoutout.raider', raiderId}`); anywhere else it faults, and raid-triggered
handlers may not call `riff.shoutout.send()`.
