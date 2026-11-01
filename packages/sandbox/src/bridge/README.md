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
